/**
 * The on-device workout store (PRD §9, §15, §18; the offline workout sync ADR): the device is the
 * first home of every workout action, and nothing here touches the network.
 *
 * - It keeps inputs, not derived state: per workout the kit, the server's canonical rows and the
 *   device state, plus the outbox. A screen shows the projection over them with its route's
 *   reducer table, and so does a reload: restore reads IndexedDB alone.
 * - dispatch applies an action and its follow-ups to the in-memory view at once, then writes the
 *   outbox entries and the device state in one readwrite transaction. A superset's set.log and its
 *   goTo, or an exercise.create and its substitution, are written together or not at all.
 * - A write that fails (quota, private mode) keeps the action in the view, marked not saved; the
 *   next write, or retry, writes it first, so the outbox keeps the order of the actions.
 * - Writes are serial within a page. Each one reads what other tabs wrote in its transaction, so
 *   none is lost; the device state is the last tab's to write.
 * - One workout is in progress at a time; a second workout.start is refused.
 * - It closes for good when the database is deleted or upgraded under it (db.ts), or when another
 *   tab says sign-out is about to delete it.
 * - Tabs (channel.ts): after each write it tells the other tabs, which re-read what changed.
 * - reconciled and adopt store the server's rows from GET /api/workouts/[id] (reconcile.ts).
 * - A finished or abandoned workout leaves the device once every change of it is acknowledged:
 *   History reads the server from then on.
 * - discard, tryAgain and fix are the owner's answers to a change that needs attention. Discard
 *   also keeps the ids it removed until the server has claimed them (discarded, forget), so a
 *   request still on its way with one of them can never land it after a newer change.
 * Plain .ts with no runes, so Vitest's unit project runs it against fake-indexeddb.
 */
import { entityKey, SYNC_CODE_LABEL } from '#lib/domain/workout/index.ts';
import type {
	CanonicalWorkout,
	DeviceState,
	EntityKey,
	ExerciseLibrary,
	KitUnits,
	LocalAction,
	Mutation,
	StartKit,
	SyncResult,
	WorkoutView
} from '#lib/domain/workout/index.ts';
import { applyLocal, applyMutation, replay, viewOf } from '#lib/domain/workout/project.ts';
import type { AnyTable, WorkoutState } from '#lib/domain/workout/project.ts';
import { initialDevice } from '#lib/domain/workout/reducers/device.ts';
import type { IDBPTransaction, StoreNames } from 'idb';
import { openTabChannel } from './channel.ts';
import type { TabChannel, TabMessage } from './channel.ts';
import { closeForGood, openWorkoutDb, StoreClosedError } from './db.ts';
import type { CachedLibrary, CloseReason, StoredWorkout, WorkoutDb, WorkoutSchema } from './db.ts';
import { LIBRARY_KEY, OUTBOX_INDEXES, STORES } from './names.ts';
import {
	applyResults,
	backOnline,
	countFailure,
	discard,
	queued,
	replaceInPlace,
	tryAgain
} from './outbox-rules.ts';
import type { OutboxEntry } from './outbox-rules.ts';

const DAY = 24 * 60 * 60 * 1000;

/**
 * prune's ages: a finished workout that holds no change of this device's after a day (one finished
 * here leaves as soon as its last change is acknowledged), a saved kit after a week. An unsynced
 * workout is never pruned.
 */
export const PRUNE_AFTER = { finishedMs: DAY, kitMs: 7 * DAY };

export type Action = Mutation | LocalAction;

/** saved: in IndexedDB; not-saved: kept in the view for retry; refused: another workout is active. */
export type WriteOutcome = 'saved' | 'not-saved' | 'refused';

/** quota: the device is out of space; storage: any other IndexedDB failure (private mode). */
export type NotSavedReason = 'quota' | 'storage';

/** An action shown but not saved on this device: its id and the rows it touches. */
export interface NotSaved {
	id: string;
	entities: EntityKey[];
	reason: NotSavedReason;
}

export interface WorkoutSnapshot {
	workoutId: string;
	/** null while no rows hold the workout. */
	view: WorkoutView | null;
	notSaved: NotSaved[];
}

export interface Dispatched {
	/** The action's id: its first mutation's, or a new one for device actions alone. */
	id: string;
	/** The view with the action applied, before anything is written. */
	snapshot: WorkoutSnapshot;
	saved: Promise<WriteOutcome>;
}

export type WorkoutHeader = Pick<StoredWorkout, 'kind' | 'title' | 'startedAt' | 'status'>;
const headerOf = ({ kind, title, startedAt, status }: StoredWorkout): WorkoutHeader => ({
	kind,
	title,
	startedAt,
	status
});

/** A workout with changes in the outbox; its header is null when only the changes remain. */
export interface UnsyncedWorkout {
	workoutId: string;
	pending: number;
	workout: WorkoutHeader | null;
}

/** purged: another tab lost the session and deleted the server's copies (the signed-out state). */
export type StoreChange =
	| { type: 'view' | 'saved' | 'not-saved'; workoutId: string }
	| { type: 'purged' }
	| { type: 'closed'; reason: CloseReason };

/** adopted: stored or refilled; held: its rows and kit are here; refused: another in progress. */
export type AdoptOutcome = 'adopted' | 'held' | 'refused';

export class ActiveWorkoutError extends Error {
	override name = 'ActiveWorkoutError';
	readonly workoutId: string;
	constructor(workoutId: string) {
		super(`Workout ${workoutId} is already in progress on this device`);
		this.workoutId = workoutId;
	}
}

export interface StoreOptions {
	table: AnyTable;
	/** Epoch ms on this device: backoff after a sync response, kit and prune ages. */
	now?: () => number;
	random?: () => number;
	/** The other tabs (channel.ts): 'pc-workout' in a browser, none elsewhere. */
	channel?: TabChannel | null;
}

export interface WorkoutStore {
	readonly closed: CloseReason | null;
	/** The workout in progress on this device, read into memory; null when there is none. */
	getActive(): Promise<WorkoutSnapshot | null>;
	/** A workout read into memory again, with what this page has not written yet on top. */
	load(workoutId: string): Promise<WorkoutSnapshot | null>;
	/** What memory holds for a workout, without reading anything. */
	snapshot(workoutId: string): WorkoutSnapshot | null;
	listUnsynced(): Promise<UnsyncedWorkout[]>;
	/** Throws StoreClosedError, ActiveWorkoutError, or RangeError for a workout not loaded. */
	dispatch(action: Action, ...followUps: Action[]): Dispatched;
	retry(actionId: string): Promise<WriteOutcome>;
	/**
	 * A sync response: entries leave the outbox or are parked, the canonical rows are stored, and a
	 * finished workout with no change left leaves the device.
	 */
	acknowledge(results: readonly SyncResult[]): Promise<void>;
	/** Every outbox entry in seq order, as IndexedDB holds it: what the sync engine sends from. */
	outbox(): Promise<OutboxEntry[]>;
	/** A 5xx or a timeout of a batch the entry heads, counted against it (outbox-rules). */
	countFailure(seq: number, error: string): Promise<void>;
	/** Back online after being offline since `offlineSince`: every entry's wait ends. */
	backOnline(offlineSince: number): Promise<void>;
	/**
	 * Discard: the entry and every change that depends on it leave the outbox, and their ids wait in
	 * `discarded` until the server has claimed them.
	 */
	discard(seq: number): Promise<void>;
	/** Try again: a stuck entry is queued again in its place, its count cleared. */
	tryAgain(seq: number): Promise<void>;
	/** Fix: the corrected change replaces the refused entry in its place, under the same id. */
	fix(seq: number, envelope: Mutation): Promise<void>;
	/** Discarded ids the server has not claimed yet: every sync request carries them first. */
	discarded(): Promise<string[]>;
	/** The server claimed these discarded ids: they are not sent again. */
	forget(ids: readonly string[]): Promise<void>;
	/**
	 * The session is gone (a 401): deletes everything the server already holds, which are the saved
	 * kits, the cached library, the owner's units, every canonical row and kit, and every finished
	 * workout. It keeps only the outbox and an unfinished workout's device state, less the previous
	 * sets attached from the server. It marks the device signed out (signedOut) until signedIn.
	 */
	purgeServerCopies(): Promise<void>;
	/** A 401 purged this device, and the server has not answered as the owner since. */
	signedOut(): Promise<boolean>;
	/** The server answered as the owner again: the pages may show the workout. */
	signedIn(): Promise<void>;
	/**
	 * The server's rows for a workout this device holds, stored as they are; the pending changes
	 * replay on top, and the device state is untouched. A pending edit of a set the rows hold as
	 * deleted is parked as 'Deleted on another device'. False when the device does not hold it.
	 */
	reconciled(canonical: CanonicalWorkout): Promise<boolean>;
	/** A workout from another device, built from its rows and kit; refills one a purge emptied. */
	adopt(canonical: CanonicalWorkout, kit: StartKit | null): Promise<AdoptOutcome>;
	saveKit(lineage: string, kit: StartKit): Promise<void>;
	getKit(lineage: string): Promise<StartKit | null>;
	/** The owner's training-profile units, as the server last gave them (a purge deletes them). */
	saveUnits(units: KitUnits): Promise<void>;
	getUnits(): Promise<KitUnits | null>;
	/** The exercise library, kept under its digest for the picker offline (a purge deletes it). */
	saveLibrary(library: ExerciseLibrary): Promise<void>;
	getLibrary(): Promise<CachedLibrary | null>;
	prune(): Promise<{ workouts: string[]; kits: string[] }>;
	onChange(listener: (change: StoreChange) => void): () => void;
	/**
	 * Closes this store, for good, and its channel, but not the page: a store created later on this
	 * page opens 'pc-offline' again. For a short-lived store its opener lets go of (sign-out's,
	 * workout/shutdown.ts). Its listeners hear 'closed' ('deleted'): nothing is left to show.
	 */
	close(): void;
}

/** Best effort: Safari evicts a site's storage after 7 days unused unless it is installed. */
export async function requestPersistence(
	storage: Pick<StorageManager, 'persist'> | undefined = globalThis.navigator?.storage
): Promise<boolean> {
	try {
		return (await storage?.persist()) ?? false;
	} catch {
		return false;
	}
}

// ---- Internals ------------------------------------------------------------------------------

/** A dispatch not written yet: its write is on its way, or failed (`failed`). */
interface Queued {
	id: string;
	actions: Action[];
	mutations: Mutation[];
	kitChanged: boolean;
	/** The kit and device state once it is applied: what its write stores. */
	after: { kit: StartKit | null; device: DeviceState };
	failed: NotSavedReason | null;
	outcome: WriteOutcome | null;
	/** Settles `saved` with the first outcome; later ones change nothing. */
	settle: (outcome: WriteOutcome) => void;
}

interface Loaded {
	workoutId: string;
	/** What IndexedDB held at this page's last read or write. */
	record: StoredWorkout | undefined;
	entries: OutboxEntry[];
	queue: Queued[];
	state: WorkoutState;
	view: WorkoutView | null;
}

type Stores = StoreNames<WorkoutSchema>;
type Tx<N extends Stores> = IDBPTransaction<WorkoutSchema, N[], 'readwrite'>;

const { byMutation: BY_MUTATION, byWorkout: BY_WORKOUT } = OUTBOX_INDEXES;
const isMutation = (action: Action): action is Mutation => 'v' in action;

/**
 * One readwrite transaction. `run` awaits nothing but its IndexedDB requests, because Safari
 * commits a transaction that awaits anything else; on any error the whole transaction aborts.
 */
async function transact<N extends Stores, T>(
	db: WorkoutDb,
	names: N[],
	run: (tx: Tx<N>) => Promise<T>
): Promise<T> {
	const tx = db.transaction(names, 'readwrite');
	const done = tx.done;
	done.catch(() => {}); // an abort below rejects it; the caller sees the error that caused it
	try {
		const value = await run(tx);
		await done;
		return value;
	} catch (error) {
		try {
			tx.abort();
		} catch {
			// it had already finished or aborted
		}
		throw error;
	}
}

const reasonOf = (error: unknown): NotSavedReason =>
	error instanceof DOMException && error.name === 'QuotaExceededError' ? 'quota' : 'storage';

/** A new outbox entry: IndexedDB assigns its seq. */
function entryOf(m: Mutation): OutboxEntry {
	const { seq: _assigned, ...entry } = queued(0, m);
	return entry as OutboxEntry;
}

/** A pending set.edit of a set the server holds as deleted: parked for Discard, as the server would. */
function parkDeleted(entry: OutboxEntry, canonical: CanonicalWorkout): OutboxEntry {
	const m = entry.envelope;
	if (entry.parked || m.type !== 'set.edit') return entry;
	if (!canonical.sets.some((s) => s.id === m.entityId && s.deletedAt !== null)) return entry;
	const parked = { reason: 'refused', errors: {}, message: SYNC_CODE_LABEL.deleted } as const;
	return { ...entry, nextAt: null, parked };
}

const fold = (table: AnyTable, state: WorkoutState, actions: readonly Action[]) =>
	actions.reduce(
		(s, a) => (isMutation(a) ? applyMutation(table, s, a) : applyLocal(table, s, a)),
		state
	);

/** A workout's record, its header read from the projection of what it holds. */
function recordOf(
	table: AnyTable,
	workoutId: string,
	inputs: Pick<StoredWorkout, 'kit' | 'canonical' | 'device'> & { entries: OutboxEntry[] },
	previous: StoredWorkout | undefined
): StoredWorkout {
	const { kit, canonical, device, entries } = inputs;
	const pending = entries.map((e) => e.envelope);
	const row = replay(table, { workoutId, kit, canonical, pending, device }).rows?.workout;
	const header = row ?? previous;
	return {
		id: workoutId,
		kind: header?.kind ?? table.kind,
		title: header?.title ?? '',
		startedAt: header?.startedAt ?? '',
		status: header?.status ?? 'in_progress',
		finishedAt: header?.finishedAt ?? null,
		kit,
		canonical,
		device
	};
}

export async function createStore({
	table,
	now = Date.now,
	random = Math.random,
	channel = typeof window === 'undefined' ? null : openTabChannel()
}: StoreOptions): Promise<WorkoutStore> {
	const listeners = new Set<(change: StoreChange) => void>();
	const emit = (change: StoreChange) => listeners.forEach((listener) => listener(change));
	let closed: CloseReason | null = null;
	let unlisten = () => {};
	/** The IndexedDB this store opens 'pc-offline' from: the page it closes for good. */
	const page = globalThis.indexedDB;
	const shut = (reason: CloseReason) => {
		if (closed) return;
		closed = reason;
		unlisten();
		channel?.close();
		emit({ type: 'closed', reason });
	};
	let db: WorkoutDb;
	try {
		db = await openWorkoutDb(shut);
	} catch (error) {
		channel?.close();
		throw error;
	}

	const memory = new Map<string, Loaded>();
	let chain: Promise<unknown> = Promise.resolve();
	/** Writes run one at a time, in the order they were asked for. */
	const serial = <T>(task: () => Promise<T>): Promise<T> => {
		const run = chain.then(task);
		chain = run.catch(() => {});
		return run;
	};
	const assertOpen = () => {
		if (closed) throw new StoreClosedError(closed);
	};

	const snapshotOf = (loaded: Loaded): WorkoutSnapshot => ({
		workoutId: loaded.workoutId,
		view: loaded.view,
		notSaved: loaded.queue.flatMap((q) =>
			q.failed ? [{ id: q.id, entities: q.mutations.map(entityKey), reason: q.failed }] : []
		)
	});

	/** The stored inputs replayed, then what this page has not written yet, in order. */
	function rebuild(loaded: Loaded) {
		const { workoutId, record, entries } = loaded;
		let state = replay(table, {
			workoutId,
			kit: record?.kit ?? null,
			canonical: record?.canonical ?? null,
			pending: entries.map((e) => e.envelope),
			device: record?.device ?? initialDevice()
		});
		for (const item of loaded.queue) {
			state = fold(table, state, item.actions);
			item.after = { kit: state.kit, device: state.device };
		}
		loaded.state = state;
		loaded.view = viewOf(table, state);
	}

	/** A workout this page holds nothing for yet. */
	const blank = (workoutId: string): Loaded => ({
		workoutId,
		record: undefined,
		entries: [],
		queue: [],
		state: replay(table, { workoutId, kit: null, canonical: null, pending: [] }),
		view: null
	});

	/** What IndexedDB holds for a workout, as memory's new base; null when nothing is left. */
	function remember(workoutId: string, record: StoredWorkout | undefined, entries: OutboxEntry[]) {
		const loaded = memory.get(workoutId) ?? blank(workoutId);
		if (!record && entries.length === 0 && loaded.queue.length === 0) {
			memory.delete(workoutId);
			return null;
		}
		Object.assign(loaded, { record, entries });
		rebuild(loaded);
		memory.set(workoutId, loaded);
		return loaded;
	}

	/** Reads are serial with the writes too, so memory always moves forward. */
	const load = (workoutId: string) =>
		serial(async (): Promise<WorkoutSnapshot | null> => {
			assertOpen();
			const tx = db.transaction([STORES.workouts, STORES.outbox], 'readonly');
			const record = await tx.objectStore(STORES.workouts).get(workoutId);
			const entries = await tx.objectStore(STORES.outbox).index(BY_WORKOUT).getAll(workoutId);
			await tx.done;
			const loaded = remember(workoutId, record, entries);
			return loaded && snapshotOf(loaded);
		});

	/** Tells the other tabs a workout was written: 'closed' once it is no longer in progress. */
	const tell = ({ id, status }: StoredWorkout) =>
		channel?.post({ type: status === 'in_progress' ? 'changed' : 'closed', workoutId: id });

	/** Memory's new base after a write here, shown, and told to the other tabs. */
	function stored(record: StoredWorkout, entries: OutboxEntry[], always = false) {
		if (always || memory.has(record.id)) {
			remember(record.id, record, entries);
			emit({ type: 'view', workoutId: record.id });
		}
		tell(record);
	}

	/** Another tab wrote these workouts: the ones in memory are read again. */
	async function reread(workoutIds: Iterable<string>) {
		for (const workoutId of [...workoutIds]) {
			try {
				if (memory.has(workoutId)) await load(workoutId);
			} catch {
				return; // closed meanwhile: nothing left to show
			}
			emit({ type: 'view', workoutId });
		}
	}

	function hear(message: TabMessage) {
		if (closed) return;
		switch (message.type) {
			case 'changed':
			case 'closed':
				return void reread([message.workoutId]);
			case 'purged':
				return void reread(memory.keys()).then(() => emit({ type: 'purged' }));
			case 'signed-out':
				// Another tab signs out and deletes the database next: this page lets go of it, for good,
				// and never opens it again (closeForGood), so a stale tab cannot recreate it after the
				// deletion. The signing-out page closes its own stores with close() instead, which leaves
				// it free to open the store again when the owner stays signed in.
				memory.clear();
				db.close();
				closeForGood(page, 'deleted');
				return shut('deleted');
		}
	}
	unlisten = channel?.listen(hear) ?? unlisten;

	/** Writes every queued action of a workout, in order, with the device state after the last. */
	async function write(workoutId: string): Promise<void> {
		const loaded = memory.get(workoutId);
		if (!loaded || loaded.queue.length === 0) return;
		const items = [...loaded.queue];
		const finish = (outcome: WriteOutcome) => items.forEach((i) => (i.outcome = outcome));
		const fail = (reason: NotSavedReason) => {
			for (const item of items) {
				item.failed = reason;
				item.settle('not-saved');
			}
			finish('not-saved');
			emit({ type: 'not-saved', workoutId });
		};
		if (closed) return fail('storage');
		const mutations = items.flatMap((i) => i.mutations);
		const { after } = items.at(-1)!;
		const kitChanged = items.some((i) => i.kitChanged);

		let written: { record: StoredWorkout; entries: OutboxEntry[] } | 'refused';
		try {
			written = await transact(db, [STORES.workouts, STORES.outbox], async (tx) => {
				const workouts = tx.objectStore(STORES.workouts);
				const outbox = tx.objectStore(STORES.outbox);
				const previous = await workouts.get(workoutId);
				if (!previous && mutations.some((m) => m.type === 'workout.start')) {
					const others = await workouts.getAll();
					if (others.some((w) => w.status === 'in_progress')) return 'refused';
				}
				for (const m of mutations) {
					const known = await outbox.index(BY_MUTATION).getKey(m.id);
					if (known === undefined) await outbox.add(entryOf(m));
				}
				const entries = await outbox.index(BY_WORKOUT).getAll(workoutId);
				const kit = kitChanged || !previous ? after.kit : previous.kit;
				const canonical = previous?.canonical ?? null;
				const inputs = { kit, canonical, device: after.device, entries };
				const record = recordOf(table, workoutId, inputs, previous);
				await workouts.put(record);
				return { record, entries };
			});
		} catch (error) {
			return fail(reasonOf(error));
		}

		if (written === 'refused') {
			// Another tab started a workout first: this one never existed.
			memory.delete(workoutId);
			for (const item of loaded.queue) item.settle('refused');
			finish('refused');
			emit({ type: 'view', workoutId });
			return;
		}
		loaded.queue = loaded.queue.filter((q) => !items.includes(q));
		Object.assign(loaded, written);
		rebuild(loaded);
		for (const item of items) item.settle('saved');
		finish('saved');
		emit({ type: 'saved', workoutId });
		tell(written.record);
	}

	function dispatch(action: Action, ...followUps: Action[]): Dispatched {
		assertOpen();
		const actions = [action, ...followUps];
		const { workoutId } = action;
		if (actions.some((a) => a.workoutId !== workoutId)) {
			throw new RangeError('One dispatch changes one workout');
		}
		let loaded = memory.get(workoutId);
		if (!loaded && actions.some((a) => a.type === 'workout.start')) {
			for (const other of memory.values()) {
				if (other.view?.workout.status === 'in_progress') {
					throw new ActiveWorkoutError(other.workoutId);
				}
			}
			loaded = blank(workoutId);
			memory.set(workoutId, loaded);
		}
		if (!loaded) throw new RangeError(`Load workout ${workoutId} before changing it`);

		const mutations = actions.filter(isMutation);
		const state = fold(table, loaded.state, actions);
		let settle!: (outcome: WriteOutcome) => void;
		const saved = new Promise<WriteOutcome>((resolve) => (settle = resolve));
		loaded.queue.push({
			id: mutations[0]?.id ?? crypto.randomUUID(),
			actions,
			mutations,
			kitChanged: actions.some((a) => a.type === 'kit.attach' && 'kit' in a),
			after: { kit: state.kit, device: state.device },
			failed: null,
			outcome: null,
			settle
		});
		loaded.state = state;
		loaded.view = viewOf(table, state);
		emit({ type: 'view', workoutId });
		void serial(() => write(workoutId));
		return { id: loaded.queue.at(-1)!.id, snapshot: snapshotOf(loaded), saved };
	}

	async function retry(actionId: string): Promise<WriteOutcome> {
		assertOpen();
		for (const loaded of memory.values()) {
			const item = loaded.queue.find((q) => q.id === actionId);
			if (!item) continue;
			await serial(() => write(loaded.workoutId));
			return item.outcome ?? 'saved';
		}
		return 'saved';
	}

	async function acknowledge(results: readonly SyncResult[]): Promise<void> {
		assertOpen();
		const written = await serial(() =>
			transact(db, [STORES.workouts, STORES.outbox], async (tx) => {
				const workouts = tx.objectStore(STORES.workouts);
				const outbox = tx.objectStore(STORES.outbox);
				const entries: OutboxEntry[] = [];
				for (const result of results) {
					const entry = await outbox.index(BY_MUTATION).get(result.id);
					if (entry) entries.push(entry);
				}
				const after = new Map(applyResults(entries, results, now(), random).map((e) => [e.seq, e]));
				for (const entry of entries) {
					const next = after.get(entry.seq);
					if (!next) await outbox.delete(entry.seq);
					else if (next !== entry) await outbox.put(next);
				}
				// The server's whole workout, on the last result of each workout that carries it.
				const rows = new Map<string, CanonicalWorkout>();
				for (const r of results) if (r.canonical) rows.set(r.canonical.workout.id, r.canonical);
				const touched = new Set([...entries.map((e) => e.envelope.workoutId), ...rows.keys()]);
				const read = new Map<string, { record: StoredWorkout; entries: OutboxEntry[] }>();
				const pruned: string[] = [];
				for (const workoutId of touched) {
					const previous = await workouts.get(workoutId);
					if (!previous) continue; // not on this device: reconcile adopts it
					const left = await outbox.index(BY_WORKOUT).getAll(workoutId);
					const canonical = rows.get(workoutId) ?? previous.canonical;
					const inputs = { kit: previous.kit, canonical, device: previous.device, entries: left };
					const record = recordOf(table, workoutId, inputs, previous);
					// Finished or abandoned, and every change of it acknowledged: History reads the server.
					if (
						record.status !== 'in_progress' &&
						!left.length &&
						!memory.get(workoutId)?.queue.length
					) {
						await workouts.delete(workoutId);
						pruned.push(workoutId);
						continue;
					}
					await workouts.put(record);
					read.set(workoutId, { record, entries: left });
				}
				return { read, pruned };
			})
		);
		for (const { record, entries } of written.read.values()) stored(record, entries);
		for (const workoutId of written.pruned) {
			if (memory.delete(workoutId)) emit({ type: 'view', workoutId });
			channel?.post({ type: 'closed', workoutId });
		}
	}

	async function outbox(): Promise<OutboxEntry[]> {
		assertOpen();
		return db.getAll(STORES.outbox);
	}

	/** An outbox rule that keeps every entry in its place (counts and waits): no view changes. */
	async function revise(rule: (entries: OutboxEntry[]) => OutboxEntry[]): Promise<void> {
		assertOpen();
		await serial(() =>
			transact(db, [STORES.outbox], async (tx) => {
				const store = tx.objectStore(STORES.outbox);
				const entries = await store.getAll();
				const next = rule(entries);
				for (const [i, entry] of next.entries()) if (entry !== entries[i]) await store.put(entry);
			})
		);
	}

	/**
	 * An owner's answer (Discard, Try again, Fix) in one transaction: the outbox as `rule` leaves it,
	 * each workout it touched re-recorded and shown, and with `remember` the removed ids kept to
	 * send as discarded. A discarded workout.start takes its workout off the device.
	 */
	async function rearrange(rule: (entries: OutboxEntry[]) => OutboxEntry[], remember = false) {
		assertOpen();
		const names = [STORES.workouts, STORES.outbox, STORES.meta];
		const written = await serial(() =>
			transact(db, names, async (tx) => {
				const outbox = tx.objectStore(STORES.outbox);
				const before = await outbox.getAll();
				const after = new Map(rule(before).map((e) => [e.seq, e]));
				const touched = new Set<string>();
				const gone: string[] = [];
				const ended = new Set<string>();
				for (const entry of before) {
					const next = after.get(entry.seq);
					if (next === entry) continue;
					touched.add(entry.envelope.workoutId);
					if (next) {
						await outbox.put(next);
					} else {
						await outbox.delete(entry.seq);
						gone.push(entry.envelope.id);
						if (entry.envelope.type === 'workout.start') ended.add(entry.envelope.workoutId);
					}
				}
				if (remember && gone.length > 0) {
					const meta = tx.objectStore(STORES.meta);
					const held = ((await meta.get('discarded'))?.value as string[] | undefined) ?? [];
					await meta.put({ key: 'discarded', value: [...held, ...gone] });
				}
				const read = new Map<string, { record: StoredWorkout; entries: OutboxEntry[] }>();
				for (const workoutId of touched) {
					if (ended.has(workoutId)) {
						await tx.objectStore(STORES.workouts).delete(workoutId);
						continue;
					}
					const previous = await tx.objectStore(STORES.workouts).get(workoutId);
					if (!previous) continue;
					const entries = await outbox.index(BY_WORKOUT).getAll(workoutId);
					const { kit, canonical, device } = previous;
					const record = recordOf(table, workoutId, { kit, canonical, device, entries }, previous);
					await tx.objectStore(STORES.workouts).put(record);
					read.set(workoutId, { record, entries });
				}
				return { read, ended };
			})
		);
		for (const { record, entries } of written.read.values()) stored(record, entries);
		for (const workoutId of written.ended) {
			if (memory.delete(workoutId)) emit({ type: 'view', workoutId });
			channel?.post({ type: 'closed', workoutId });
		}
	}

	async function discarded(): Promise<string[]> {
		assertOpen();
		return ((await db.get(STORES.meta, 'discarded'))?.value as string[] | undefined) ?? [];
	}

	async function forget(ids: readonly string[]): Promise<void> {
		assertOpen();
		await serial(() =>
			transact(db, [STORES.meta], async (tx) => {
				const meta = tx.objectStore(STORES.meta);
				const held = ((await meta.get('discarded'))?.value as string[] | undefined) ?? [];
				await meta.put({ key: 'discarded', value: held.filter((id) => !ids.includes(id)) });
			})
		);
	}

	async function purgeServerCopies(): Promise<void> {
		assertOpen();
		const names = [STORES.workouts, STORES.outbox, STORES.kits, STORES.library, STORES.meta];
		const left = await serial(() =>
			transact(db, names, async (tx) => {
				await tx.objectStore(STORES.kits).clear();
				await tx.objectStore(STORES.library).clear();
				// What the server sent; the discarded ids are the device's, still to send.
				await tx.objectStore(STORES.meta).delete('units');
				await tx.objectStore(STORES.meta).delete('lastSync');
				await tx.objectStore(STORES.meta).put({ key: 'signedOut', value: true });
				const workouts = tx.objectStore(STORES.workouts);
				const kept = new Map<string, { record?: StoredWorkout; entries: OutboxEntry[] }>();
				for (const workout of await workouts.getAll()) {
					const entries = await tx.objectStore(STORES.outbox).index(BY_WORKOUT).getAll(workout.id);
					if (workout.status !== 'in_progress') {
						await workouts.delete(workout.id);
						kept.set(workout.id, { entries });
						continue;
					}
					// Its header comes only from changes still in the outbox: none from the server.
					const device = { ...workout.device, attached: {} };
					const inputs = { kit: null, canonical: null, device, entries };
					const record = recordOf(table, workout.id, inputs, undefined);
					await workouts.put(record);
					kept.set(workout.id, { record, entries });
				}
				return kept;
			})
		);
		for (const [workoutId, { record, entries }] of left) {
			if (!memory.has(workoutId)) continue;
			remember(workoutId, record, entries);
			emit({ type: 'view', workoutId });
		}
		channel?.post({ type: 'purged' });
	}

	async function reconciled(canonical: CanonicalWorkout): Promise<boolean> {
		assertOpen();
		const workoutId = canonical.workout.id;
		const written = await serial(() =>
			transact(db, [STORES.workouts, STORES.outbox], async (tx) => {
				const previous = await tx.objectStore(STORES.workouts).get(workoutId);
				if (!previous) return null;
				const outbox = tx.objectStore(STORES.outbox);
				const entries: OutboxEntry[] = [];
				for (const entry of await outbox.index(BY_WORKOUT).getAll(workoutId)) {
					const next = parkDeleted(entry, canonical);
					if (next !== entry) await outbox.put(next);
					entries.push(next);
				}
				const { kit, device } = previous;
				const record = recordOf(table, workoutId, { kit, canonical, device, entries }, previous);
				await tx.objectStore(STORES.workouts).put(record);
				return { record, entries };
			})
		);
		if (written) stored(written.record, written.entries);
		return written !== null;
	}

	async function adopt(canonical: CanonicalWorkout, kit: StartKit | null): Promise<AdoptOutcome> {
		assertOpen();
		const workoutId = canonical.workout.id;
		const written = await serial(() =>
			transact(db, [STORES.workouts, STORES.outbox], async (tx) => {
				const workouts = tx.objectStore(STORES.workouts);
				// Held without rows or a kit (as a purge leaves it): filled in, keeping its device state.
				const held = await workouts.get(workoutId);
				if (held?.canonical && (held.kit || !kit)) return 'held';
				const others = await workouts.getAll();
				if (others.some((w) => w.id !== workoutId && w.status === 'in_progress')) return 'refused';
				const entries = await tx.objectStore(STORES.outbox).index(BY_WORKOUT).getAll(workoutId);
				const device = held?.device ?? initialDevice();
				const inputs = { kit: held?.kit ?? kit, canonical, device, entries };
				const record = recordOf(table, workoutId, inputs, held);
				await workouts.put(record);
				return { record, entries };
			})
		);
		if (typeof written === 'string') return written;
		stored(written.record, written.entries, true);
		return 'adopted';
	}

	async function listUnsynced(): Promise<UnsyncedWorkout[]> {
		assertOpen();
		const tx = db.transaction([STORES.workouts, STORES.outbox], 'readonly');
		const pending = new Map<string, number>();
		for (const { envelope } of await tx.objectStore(STORES.outbox).getAll()) {
			pending.set(envelope.workoutId, (pending.get(envelope.workoutId) ?? 0) + 1);
		}
		const list: UnsyncedWorkout[] = [];
		for (const [workoutId, count] of pending) {
			const record = await tx.objectStore(STORES.workouts).get(workoutId);
			list.push({ workoutId, pending: count, workout: record ? headerOf(record) : null });
		}
		await tx.done;
		return list;
	}

	async function prune() {
		assertOpen();
		const gone = await serial(() =>
			transact(db, [STORES.workouts, STORES.outbox, STORES.kits], async (tx) => {
				const at = now();
				const pruned = { workouts: [] as string[], kits: [] as string[] };
				for (const w of await tx.objectStore(STORES.workouts).getAll()) {
					if (w.status === 'in_progress' || w.finishedAt === null) continue;
					if (at - Date.parse(w.finishedAt) < PRUNE_AFTER.finishedMs) continue;
					if (memory.get(w.id)?.queue.length) continue; // not saved yet: not synced
					if ((await tx.objectStore(STORES.outbox).index(BY_WORKOUT).count(w.id)) > 0) continue;
					await tx.objectStore(STORES.workouts).delete(w.id);
					pruned.workouts.push(w.id);
				}
				for (const { lineage, savedAt } of await tx.objectStore(STORES.kits).getAll()) {
					if (at - savedAt < PRUNE_AFTER.kitMs) continue;
					await tx.objectStore(STORES.kits).delete(lineage);
					pruned.kits.push(lineage);
				}
				return pruned;
			})
		);
		for (const workoutId of gone.workouts) {
			if (memory.delete(workoutId)) emit({ type: 'view', workoutId });
			channel?.post({ type: 'closed', workoutId });
		}
		return gone;
	}

	return {
		get closed() {
			return closed;
		},
		async getActive() {
			assertOpen();
			const active = (await db.getAll(STORES.workouts))
				.filter((w) => w.status === 'in_progress')
				.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
			return active ? load(active.id) : null;
		},
		load,
		snapshot: (workoutId) => {
			const loaded = memory.get(workoutId);
			return loaded ? snapshotOf(loaded) : null;
		},
		listUnsynced,
		dispatch,
		retry,
		acknowledge,
		outbox,
		countFailure: (seq, error) => revise((entries) => countFailure(entries, seq, error, now())),
		backOnline: (offlineSince) => revise((entries) => backOnline(entries, offlineSince, now())),
		discard: (seq) => rearrange((entries) => discard(entries, seq), true),
		tryAgain: (seq) => rearrange((entries) => tryAgain(entries, seq)),
		fix: (seq, envelope) => rearrange((entries) => replaceInPlace(entries, seq, envelope)),
		discarded,
		forget,
		purgeServerCopies,
		async signedOut() {
			assertOpen();
			return (await db.get(STORES.meta, 'signedOut')) !== undefined;
		},
		async signedIn() {
			assertOpen();
			await db.delete(STORES.meta, 'signedOut');
		},
		reconciled,
		adopt,
		async saveKit(lineage, kit) {
			assertOpen();
			await db.put(STORES.kits, { lineage, kit, savedAt: now() });
		},
		async getKit(lineage) {
			assertOpen();
			return (await db.get(STORES.kits, lineage))?.kit ?? null;
		},
		async saveUnits(units) {
			assertOpen();
			await db.put(STORES.meta, { key: 'units', value: units });
		},
		async getUnits() {
			assertOpen();
			const record = await db.get(STORES.meta, 'units');
			return record?.key === 'units' ? record.value : null;
		},
		async saveLibrary({ digest, units, exercises }) {
			assertOpen();
			await db.put(STORES.library, { id: LIBRARY_KEY, digest, units, exercises, savedAt: now() });
		},
		async getLibrary() {
			assertOpen();
			return (await db.get(STORES.library, LIBRARY_KEY)) ?? null;
		},
		prune,
		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		close() {
			if (closed) return;
			memory.clear();
			db.close();
			shut('deleted');
		}
	};
}
