import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { deleteDB, openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import { createMutation } from '#lib/domain/workout/index.ts';
import type {
	CanonicalWorkout,
	LocalAction,
	LoggedSet,
	Mutation,
	MutationInput,
	MutationOf,
	MutationType,
	StartKit,
	SyncResult,
	WorkoutView
} from '#lib/domain/workout/index.ts';
import { replay } from '#lib/domain/workout/project.ts';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import { broadcast, isTabMessage, openTabChannel, TAB_CHANNEL } from './channel';
import type { TabChannel } from './channel';
import { StoreClosedError } from './db';
import type { StoredWorkout } from './db';
import { DB_NAME, STORES } from './names';
import type { OutboxEntry } from './outbox-rules';
import { EARLY_ROWS, type EarlyRows } from './prepaint';
import {
	createReconciler,
	kitUrl,
	RECONCILE_TIMEOUT_MS,
	takeEarlyRows,
	workoutUrl
} from './reconcile';
import type { ReconcileOptions } from './reconcile';
import { createStore } from './store';
import type { StoreChange, WorkoutStore } from './store';

const KIT = workoutDayKits({ date: '2026-11-06' }).strength;
const T0 = Date.parse('2026-11-06T18:00:00.000Z');
const W = '00000000-0000-4000-8000-0000000000a1';
const W2 = '00000000-0000-4000-8000-0000000000a2';

let clock = T0;
let ids = 0;
const fresh = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;
const iso = (ms = clock) => new Date(ms).toISOString();

function make<T extends MutationType>(
	type: T,
	input: Omit<MutationInput<T>, 'at' | 'workoutId'> & { workoutId?: string; at?: string }
): MutationOf<T> {
	return createMutation(type, { workoutId: W, at: iso(), ...input }, fresh);
}

const start = (workoutId = W) =>
	make('workout.start', {
		workoutId,
		entityId: workoutId,
		payload: {
			kind: 'strength',
			title: KIT.title,
			sessionType: KIT.sessionType,
			discipline: KIT.discipline,
			plannedSessionId: KIT.plannedSessionId,
			plannedLineage: KIT.plannedLineage,
			programId: KIT.programId
		}
	});
const attach = (workoutId = W): LocalAction => ({ type: 'kit.attach', workoutId, kit: KIT });

const done: LoggedSet = {
	reps: 5,
	seconds: null,
	metres: null,
	weight: 100,
	assistance: null,
	unit: 'kg',
	rpe: 8,
	missedReps: 0,
	isWarmup: false,
	isExtra: false
};

/** set.log of set `id`, the squat's by default. */
function log(id: string, setIndex: number, { position = 1, workoutId = W } = {}) {
	const slot = KIT.exercises[position - 1]!;
	return make('set.log', {
		workoutId,
		entityId: id,
		payload: {
			position,
			plannedLineage: slot.plannedLineage,
			setIndex,
			exerciseId: slot.exercise.id,
			...done
		}
	});
}
const edit = (id: string, weight: number) =>
	make('set.edit', { entityId: id, payload: { ...done, weight } });

const open = (channel: TabChannel | null = null) =>
	createStore({ table: strengthTable, now: () => clock, random: () => 0.5, channel });

/** The server's rows after it applied `mutations`: the same reducers on the canonical shape. */
const serverRows = (mutations: Mutation[], workoutId = W): CanonicalWorkout =>
	replay(strengthTable, { workoutId, kit: KIT, canonical: null, pending: mutations }).rows!;

/** A sync response that applied every mutation, the last carrying the workout's rows. */
const appliedAll = (mutations: Mutation[], rows = serverRows(mutations)): SyncResult[] =>
	mutations.map((m, i) => ({
		id: m.id,
		status: 'applied',
		...(i === mutations.length - 1 ? { canonical: rows } : {})
	}));

/** Writes each action and checks it was saved. */
async function write(store: WorkoutStore, ...actions: (Mutation | LocalAction)[]) {
	const [first, ...rest] = actions;
	expect(await store.dispatch(first!, ...rest).saved).toBe('saved');
}

/** What the database holds, read past the store. */
async function stored() {
	const db = await openDB(DB_NAME);
	const workouts = (await db.getAll(STORES.workouts)) as StoredWorkout[];
	const outbox = (await db.getAll(STORES.outbox)) as OutboxEntry[];
	db.close();
	return { workouts, outbox };
}

const setsOf = (view: WorkoutView | null | undefined) => view!.slots.flatMap((slot) => slot.sets);
const setIds = (view: WorkoutView | null | undefined) => setsOf(view).map((s) => s.id);

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** GET /api/workouts/[id] and GET /api/workouts/kit?session=, from what the test puts here. */
function fakeApi() {
	const workouts = new Map<string, CanonicalWorkout>();
	const kits = new Map<string, StartKit>();
	const calls: { url: string; signal: AbortSignal }[] = [];
	let hang = false;
	const fetch = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
		const signal = init.signal!;
		calls.push({ url, signal });
		if (hang) {
			return new Promise<never>((_, reject) =>
				signal.addEventListener('abort', () =>
					reject(new DOMException('This operation was aborted', 'AbortError'))
				)
			);
		}
		const session = new URL(url, 'https://pc.test').searchParams.get('session');
		const found = session ? kits.get(session) : workouts.get(url.split('/').at(-1)!);
		return found ? json(200, found) : json(404, { error: 'not_found' });
	});
	return {
		fetch,
		workouts,
		kits,
		calls,
		set hang(value: boolean) {
			hang = value;
		}
	};
}

/** The reconciler's timers, moved by hand. */
function manualTimers() {
	let time = 0;
	const timers = new Map<number, { at: number; run: () => void }>();
	let next = 0;
	return {
		setTimeout: (run: () => void, ms: number) => {
			timers.set(++next, { at: time + ms, run });
			return next;
		},
		clearTimeout: (timer: unknown) => void timers.delete(timer as number),
		get pending() {
			return timers.size;
		},
		advance(ms: number) {
			time += ms;
			for (const [id, timer] of [...timers]) {
				if (timer.at > time) continue;
				timers.delete(id);
				timer.run();
			}
		}
	};
}

let api: ReturnType<typeof fakeApi>;
const reconcilerOf = (store: WorkoutStore, options: Partial<ReconcileOptions> = {}) =>
	createReconciler({ store, fetch: api.fetch, online: () => true, ...options });

/** A started workout whose start and `logged` sets the server acknowledged. */
async function synced(store: WorkoutStore, ...logged: Mutation[]) {
	const begun = start();
	await write(store, begun, attach());
	for (const m of logged) await write(store, m);
	await store.acknowledge(appliedAll([begun, ...logged]));
	expect(await store.outbox()).toEqual([]);
	return begun;
}

beforeEach(() => {
	vi.stubGlobal('indexedDB', new IDBFactory());
	clock = T0;
	api = fakeApi();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('reconcile', () => {
	it('shows another device’s sets and the pending local sets, once each', async () => {
		const store = await open();
		const s1 = log('s1', 1);
		const begun = await synced(store, s1);
		const s2 = log('s2', 2);
		const s3 = log('s3', 3);
		await write(store, s2);
		await write(store, s3);
		// Another device logged two sets of the second exercise; s2 reached the server too, but its
		// answer was lost on the way back, so it is still pending here.
		const o1 = log('o1', 1, { position: 2 });
		const o2 = log('o2', 2, { position: 2 });
		const rows = serverRows([begun, s1, o1, s2, o2]);
		api.workouts.set(W, rows);

		expect(await reconcilerOf(store).reconcile(W)).toBe('reconciled');

		const view = store.snapshot(W)!.view;
		expect(setIds(view)).toEqual(['s1', 's2', 's3', 'o1', 'o2']);
		expect(setsOf(view).map((s) => [s.id, s.pending])).toEqual([
			['s1', false],
			['s2', true],
			['s3', true],
			['o1', false],
			['o2', false]
		]);
		const db = await stored();
		expect(db.workouts[0]!.canonical).toStrictEqual(rows);
		expect(db.outbox.map((e) => e.envelope.id)).toEqual(['s2', 's3']);
		expect(api.calls.map((c) => c.url)).toEqual([workoutUrl(W)]);
		// A reload shows the same.
		expect(setIds((await (await open()).getActive())!.view)).toEqual(setIds(view));
	});

	it('lets a pending local edit beat a stale server value until it is acknowledged', async () => {
		const store = await open();
		const s1 = log('s1', 1);
		const begun = await synced(store, s1);
		const mine = edit('s1', 110);
		await write(store, mine);
		api.workouts.set(W, serverRows([begun, s1]));

		await reconcilerOf(store).reconcile(W);
		expect(setsOf(store.snapshot(W)!.view)[0]).toMatchObject({ weight: 110, pending: true });

		// The server applied it, then another device's later edit: the last applied wins.
		const theirs = edit('s1', 105);
		const rows = serverRows([begun, s1, mine, theirs]);
		await store.acknowledge(appliedAll([mine], rows));
		expect(setsOf(store.snapshot(W)!.view)[0]).toMatchObject({ weight: 105, pending: false });
		api.workouts.set(W, rows);
		await reconcilerOf(store).reconcile(W);
		expect(setsOf(store.snapshot(W)!.view)[0]).toMatchObject({ weight: 105, pending: false });
	});

	it('parks a pending edit of a set the server shows deleted, and only that one', async () => {
		const store = await open();
		const s1 = log('s1', 1);
		const s2 = log('s2', 2);
		const begun = await synced(store, s1, s2);
		const lost = edit('s1', 110);
		const kept = edit('s2', 120);
		await write(store, lost);
		await write(store, kept);
		const deleted = make('set.delete', { entityId: 's1', payload: {} });
		api.workouts.set(W, serverRows([begun, s1, s2, deleted]));

		expect(await reconcilerOf(store).reconcile(W)).toBe('reconciled');

		const { outbox } = await stored();
		expect(outbox.find((e) => e.envelope.id === lost.id)!.parked).toEqual({
			reason: 'refused',
			errors: {},
			message: 'Deleted on another device'
		});
		expect(outbox.find((e) => e.envelope.id === kept.id)!.parked).toBeUndefined();
		const view = store.snapshot(W)!.view;
		expect(setsOf(view).map((s) => [s.id, s.weight])).toEqual([['s2', 120]]);
	});

	it.each([
		['workout.finish', 'completed'],
		['workout.abandon', 'abandoned']
	] as const)(
		'ends a workout here after %s on another device, with the server’s values',
		async (type, status) => {
			const store = await open();
			const s1 = log('s1', 1);
			const begun = await synced(store, s1);
			const finishedAt = iso(T0 + 3_600_000);
			const ended =
				type === 'workout.finish'
					? make(type, { at: finishedAt, payload: { notes: 'Done on the laptop', sessionRpe: 8 } })
					: make(type, { at: finishedAt, payload: {} });
			api.workouts.set(W, serverRows([begun, s1, ended]));

			await reconcilerOf(store).reconcile(W);

			const { workout } = store.snapshot(W)!.view!;
			expect(workout).toMatchObject({ status, finishedAt });
			if (type === 'workout.finish') expect(workout).toMatchObject({ notes: 'Done on the laptop' });
			expect((await stored()).workouts[0]).toMatchObject({ status, finishedAt });
			expect(await (await open()).getActive()).toBeNull();
		}
	);

	it('never touches the device state', async () => {
		const store = await open();
		const s1 = log('s1', 1);
		const begun = await synced(store, s1);
		const rest: LocalAction = { type: 'rest.start', workoutId: W, at: T0, durationMs: 90_000 };
		const draft: LocalAction = {
			type: 'draft',
			workoutId: W,
			position: 3,
			setIndex: 1,
			draft: { weight: 60 }
		};
		await write(store, { type: 'goTo', workoutId: W, position: 3 }, rest, draft);
		const before = (await stored()).workouts[0]!.device;
		api.workouts.set(W, serverRows([begun, s1, log('o1', 1, { position: 3 })]));

		expect(await reconcilerOf(store).reconcile(W)).toBe('reconciled');

		expect((await stored()).workouts[0]!.device).toStrictEqual(before);
		expect(store.snapshot(W)!.view!.device).toStrictEqual(before);
		expect(setIds(store.snapshot(W)!.view)).toEqual(['s1', 'o1']);
	});

	it('fetches nothing and changes nothing offline', async () => {
		const store = await open();
		const begun = await synced(store, log('s1', 1));
		api.workouts.set(W, serverRows([begun, log('o1', 1, { position: 2 })]));
		const before = await stored();

		expect(await reconcilerOf(store, { online: () => false }).reconcile(W)).toBe('offline');

		expect(api.fetch).not.toHaveBeenCalled();
		expect(await stored()).toStrictEqual(before);
	});

	it('aborts a GET that never answers at 10 s, and changes nothing', async () => {
		const store = await open();
		const begun = await synced(store, log('s1', 1));
		api.workouts.set(W, serverRows([begun, log('o1', 1, { position: 2 })]));
		api.hang = true;
		const before = await stored();
		const timers = manualTimers();

		const outcome = reconcilerOf(store, timers).reconcile(W);
		const { signal } = api.calls[0]!;
		timers.advance(RECONCILE_TIMEOUT_MS - 1);
		expect(signal.aborted).toBe(false);
		timers.advance(1);
		expect(signal.aborted).toBe(true);

		expect(await outcome).toBe('failed');
		expect(timers.pending).toBe(0);
		expect(await stored()).toStrictEqual(before);
		expect(setIds(store.snapshot(W)!.view)).toEqual(['s1']);
	});

	it('changes nothing on a 5xx, or on rows that are not this workout’s', async () => {
		const store = await open();
		await synced(store, log('s1', 1));
		const before = await stored();
		api.fetch.mockResolvedValueOnce(json(503, { error: 'unavailable' }));
		expect(await reconcilerOf(store).reconcile(W)).toBe('failed');
		api.fetch.mockResolvedValueOnce(json(200, serverRows([start(W2)], W2)));
		expect(await reconcilerOf(store).reconcile(W)).toBe('failed');
		expect(await stored()).toStrictEqual(before);
	});

	it('keeps everything on a 404 while workout.start is pending, and applies the rows after the flush', async () => {
		const store = await open();
		const begun = start();
		const s1 = log('s1', 1);
		await write(store, begun, attach());
		await write(store, s1);
		const before = await stored();

		expect(await reconcilerOf(store).reconcile(W)).toBe('start-pending');
		expect(await stored()).toStrictEqual(before);
		expect(setIds(store.snapshot(W)!.view)).toEqual(['s1']);

		// The flush: the server applies both, and another device has logged a set since.
		await store.acknowledge(appliedAll([begun, s1]));
		api.workouts.set(W, serverRows([begun, s1, log('o1', 1, { position: 2 })]));
		expect(await reconcilerOf(store).reconcile(W)).toBe('reconciled');
		expect(setIds(store.snapshot(W)!.view)).toEqual(['s1', 'o1']);
	});

	it('keeps the local copy and every pending change on a 404 after the start was acknowledged', async () => {
		const store = await open();
		await synced(store, log('s1', 1));
		await write(store, log('s2', 2));
		await write(store, edit('s1', 110));
		const before = await stored();

		expect(await reconcilerOf(store).reconcile(W)).toBe('lost');

		expect(await stored()).toStrictEqual(before);
		expect(before.outbox).toHaveLength(2);
		expect(setIds(store.snapshot(W)!.view)).toEqual(['s1', 's2']);
	});

	it('lets go of a refusal it does not read, so the request ends (the page goes network-idle)', async () => {
		const store = await open();
		await synced(store);
		let cancelled = false;
		const body = new ReadableStream({ cancel: () => void (cancelled = true) });
		api.fetch.mockResolvedValueOnce(new Response(body, { status: 404 }));

		expect(await reconcilerOf(store).reconcile(W)).toBe('lost');
		await vi.waitFor(() => expect(cancelled).toBe(true));
	});

	it('leaves a workout this device does not hold to adoption', async () => {
		const store = await open();
		api.workouts.set(W, serverRows([start()]));
		expect(await reconcilerOf(store).reconcile(W)).toBe('not-held');
		expect((await stored()).workouts).toEqual([]);
	});
});

describe('the GET already out (prepaint.ts, EARLY_ROWS)', () => {
	/** A GET the inline script started: answered with `answer`, or never (rejects on its abort). */
	function earlyRows(answer?: Response): EarlyRows {
		const controller = new AbortController();
		const response = answer
			? Promise.resolve(answer)
			: new Promise<Response>((_, reject) =>
					controller.signal.addEventListener('abort', () =>
						reject(new DOMException('This operation was aborted', 'AbortError'))
					)
				);
		return { workoutId: W, response, controller };
	}

	it('answers from it, sends no GET of its own, and asks for it once', async () => {
		const store = await open();
		const s1 = log('s1', 1);
		const begun = await synced(store, s1);
		const rows = serverRows([begun, s1, log('o1', 1, { position: 2 })]);
		const early = vi.fn(() => earlyRows(json(200, rows)));
		const reconciler = reconcilerOf(store, { early });

		expect(await reconciler.reconcile(W)).toBe('reconciled');

		expect(early).toHaveBeenCalledExactlyOnceWith(W);
		expect(api.fetch).not.toHaveBeenCalled();
		expect(setIds(store.snapshot(W)!.view)).toEqual(['s1', 'o1']);
		expect((await stored()).workouts[0]!.canonical).toStrictEqual(rows);

		// The next reconcile (becoming visible, after a sync) sends its own.
		expect(await reconciler.reconcile(W)).toBe('lost');
		expect(early).toHaveBeenCalledTimes(1);
		expect(api.calls.map((c) => c.url)).toEqual([workoutUrl(W)]);
	});

	it('sends its own when the page hands it none', async () => {
		const store = await open();
		await synced(store, log('s1', 1));
		const early = vi.fn(() => null);
		expect(await reconcilerOf(store, { early }).reconcile(W)).toBe('lost');
		expect(early).toHaveBeenCalledExactlyOnceWith(W);
		expect(api.calls.map((c) => c.url)).toEqual([workoutUrl(W)]);
	});

	it('aborts it at 10 s as it would its own, and changes nothing', async () => {
		const store = await open();
		await synced(store, log('s1', 1));
		const before = await stored();
		const timers = manualTimers();
		const early = earlyRows();

		const outcome = reconcilerOf(store, { ...timers, early: () => early }).reconcile(W);
		await vi.waitFor(() => expect(timers.pending).toBe(1));
		timers.advance(RECONCILE_TIMEOUT_MS - 1);
		expect(early.controller.signal.aborted).toBe(false);
		timers.advance(1);
		expect(early.controller.signal.aborted).toBe(true);

		expect(await outcome).toBe('failed');
		expect(timers.pending).toBe(0);
		expect(api.fetch).not.toHaveBeenCalled();
		expect(await stored()).toStrictEqual(before);
	});

	it('is taken from the page once, and only as the inline script leaves it', () => {
		const early = earlyRows();
		const page: Record<string, unknown> = { [EARLY_ROWS]: early };
		expect(takeEarlyRows(page)).toBe(early);
		expect(page).toEqual({});
		expect(takeEarlyRows(page)).toBeNull();

		for (const left of [
			null,
			{ ...early, workoutId: 7 },
			{ ...early, response: {} },
			{ workoutId: W }
		]) {
			const other: Record<string, unknown> = { [EARLY_ROWS]: left };
			expect(takeEarlyRows(other)).toBeNull();
			expect(other).toEqual({});
		}
	});
});

describe('adoptRemote', () => {
	it('builds the same view the original device shows', async () => {
		const original = await open();
		const s1 = log('s1', 1);
		const s2 = log('s2', 1, { position: 2 });
		const begun = await synced(original, s1, s2);
		const shown = original.snapshot(W)!.view!;
		api.workouts.set(W, serverRows([begun, s1, s2]));
		api.kits.set(KIT.plannedSessionId!, KIT);

		vi.stubGlobal('indexedDB', new IDBFactory()); // another device
		const here = await open();
		const changes: StoreChange[] = [];
		here.onChange((change) => changes.push(change));

		expect(await reconcilerOf(here).adoptRemote(W)).toBe('adopted');

		expect(api.calls.map((c) => c.url)).toEqual([workoutUrl(W), kitUrl(KIT.plannedSessionId!)]);
		const adopted = here.snapshot(W)!.view!;
		expect({ ...adopted, device: null }).toEqual({ ...shown, device: null });
		expect(adopted.slots.map((s) => s.position)).toEqual(KIT.exercises.map((e) => e.position));
		expect(changes).toEqual([{ type: 'view', workoutId: W }]);
		const restored = await (await open()).getActive();
		expect(restored!.view).toEqual(adopted);
		expect(await here.outbox()).toEqual([]);
		// Adopted once: from then on it is reconciled.
		expect(await reconcilerOf(here).adoptRemote(W)).toBe('held');
	});

	it('rebuilds a workout a purge emptied, keeping its pending sets, whether or not a reconcile came first', async () => {
		for (const reconcileFirst of [false, true]) {
			vi.stubGlobal('indexedDB', new IDBFactory());
			const store = await open();
			const s1 = log('s1', 1);
			const begun = await synced(store, s1);
			const shown = store.snapshot(W)!.view!;
			await write(store, log('s2', 2));
			await store.purgeServerCopies();
			expect(store.snapshot(W)!.view).toBeNull(); // the signed-out state: no details
			api.workouts.set(W, serverRows([begun, s1]));
			api.kits.set(KIT.plannedSessionId!, KIT);

			// Signed in again: the rows and the kit pinned to its session come back.
			const reconciler = reconcilerOf(store);
			if (reconcileFirst) expect(await reconciler.reconcile(W)).toBe('reconciled');
			expect(await reconciler.adoptRemote(W)).toBe('adopted');

			const view = store.snapshot(W)!.view!;
			expect(view.kit).toEqual(KIT);
			expect(view.slots.map((s) => s.position)).toEqual(shown.slots.map((s) => s.position));
			expect(setIds(view)).toEqual(['s1', 's2']);
			expect((await store.outbox()).map((e) => e.envelope.entityId)).toEqual(['s2']);
			expect(await reconciler.adoptRemote(W)).toBe('held');
		}
	});

	it('adopts nothing that is finished, unknown, or while another workout is in progress', async () => {
		const store = await open();
		const begun = start();
		api.workouts.set(W, serverRows([begun, make('workout.finish', { payload: {} })]));
		expect(await reconcilerOf(store).adoptRemote(W)).toBe('ended');
		expect(await reconcilerOf(store).adoptRemote(W2)).toBe('missing');

		await write(store, start(W2), attach(W2));
		api.workouts.set(W, serverRows([begun]));
		expect(await reconcilerOf(store).adoptRemote(W)).toBe('refused');
		expect((await stored()).workouts.map((w) => w.id)).toEqual([W2]);
		expect(await reconcilerOf(store, { online: () => false }).adoptRemote(W)).toBe('offline');
	});

	it('adopts with no kit when the session has none to pin, and fails when the kit cannot be read', async () => {
		const store = await open();
		api.workouts.set(W, serverRows([start(), log('o1', 1)]));
		api.fetch.mockImplementationOnce(api.fetch.getMockImplementation()!);
		api.fetch.mockImplementationOnce(async () => {
			throw new TypeError('Failed to fetch');
		});
		expect(await reconcilerOf(store).adoptRemote(W)).toBe('failed');
		expect((await stored()).workouts).toEqual([]);

		expect(await reconcilerOf(store).adoptRemote(W)).toBe('adopted');
		const view = store.snapshot(W)!.view!;
		expect(view.kit).toBeNull();
		expect(setIds(view)).toEqual(['o1']);
	});
});

// ---- Tabs --------------------------------------------------------------------------------------

let channels: TabChannel[] = [];
let tabRun = 0;
let name = TAB_CHANNEL;

/** One tab: a store on the shared database, with its own end of this test's channel. */
const tab = () => {
	const channel = openTabChannel(name)!;
	channels.push(channel);
	return open(channel);
};

/** The next change a store emits that satisfies `ok`; fails after a second. */
const next = (store: WorkoutStore, ok: (change: StoreChange) => boolean = () => true) =>
	new Promise<StoreChange>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('No change reached the other tab')), 1000);
		const off = store.onChange((change) => {
			if (!ok(change)) return;
			clearTimeout(timer);
			off();
			resolve(change);
		});
	});

describe('tabs', () => {
	beforeEach(() => {
		name = `${TAB_CHANNEL}-test-${++tabRun}`;
	});
	afterEach(() => {
		channels.forEach((c) => c.close());
		channels = [];
	});

	it('shows each tab what the other wrote, through the channel', async () => {
		const a = await tab();
		const b = await tab();
		await write(a, start(), attach());
		expect((await b.getActive())!.workoutId).toBe(W);

		const seen = next(b, (c) => c.type === 'view' && setIds(b.snapshot(W)!.view).includes('s1'));
		await write(a, log('s1', 1));
		await seen;
		expect(setIds(b.snapshot(W)!.view)).toEqual(['s1']);

		const back = next(a, (c) => c.type === 'view' && setIds(a.snapshot(W)!.view).length === 2);
		await write(b, log('s2', 2));
		await back;
		expect(setIds(a.snapshot(W)!.view)).toEqual(['s1', 's2']);

		const ended = next(b, () => b.snapshot(W)!.view!.workout.status === 'completed');
		await write(a, make('workout.finish', { payload: {} }));
		await ended;

		// Without the channel a tab sees nothing until it reads again.
		const alone = await open(null);
		await alone.load(W);
		await write(a, log('s3', 3));
		await next(b, () => setIds(b.snapshot(W)!.view).includes('s3'));
		expect(setIds(alone.snapshot(W)!.view)).toEqual(['s1', 's2']);
	});

	it('tells the other tabs of a reconcile', async () => {
		const a = await tab();
		const b = await tab();
		const begun = await synced(a, log('s1', 1));
		await b.load(W);
		api.workouts.set(W, serverRows([begun, log('s1', 1), log('o1', 1, { position: 2 })]));

		const seen = next(b, () => setIds(b.snapshot(W)!.view).includes('o1'));
		await reconcilerOf(a).reconcile(W);
		await seen;
	});

	it('makes the other tab re-read and show the signed-out state after a purge', async () => {
		const a = await tab();
		const b = await tab();
		await synced(a, log('s1', 1));
		await write(a, log('s2', 2));
		await b.load(W);
		expect(b.snapshot(W)!.view!.kit).not.toBeNull();

		const purged = next(b, (c) => c.type === 'purged');
		await a.purgeServerCopies();
		await purged;

		// Nothing from the server is left: no rows, no kit, no names; only the change waiting.
		expect(b.snapshot(W)).toEqual({ workoutId: W, view: null, notSaved: [], pending: 0 });
		expect(await b.listUnsynced()).toEqual([
			{ workoutId: W, pending: 1, workout: expect.anything() }
		]);
	});

	it('closes the other tab for good on signed-out, so deleting the database is never blocked', async () => {
		const b = await tab();
		await write(b, start(), attach());
		const closed = next(b, (c) => c.type === 'closed');

		broadcast({ type: 'signed-out' }, name);

		expect(await closed).toEqual({ type: 'closed', reason: 'deleted' });
		expect(b.closed).toBe('deleted');
		expect(b.snapshot(W)).toBeNull();
		expect(() => b.dispatch(log('s1', 1))).toThrow(StoreClosedError);
		await expect(b.load(W)).rejects.toThrow(StoreClosedError);
		let blocked = false;
		await deleteDB(DB_NAME, { blocked: () => (blocked = true) });
		expect(blocked).toBe(false);
	});

	it('reads only its own messages from the channel', () => {
		expect(isTabMessage({ type: 'changed', workoutId: W })).toBe(true);
		expect(isTabMessage({ type: 'signed-out' })).toBe(true);
		expect(isTabMessage({ type: 'changed' })).toBe(false);
		expect(isTabMessage({ type: 'reload' })).toBe(false);
		expect(isTabMessage('signed-out')).toBe(false);
		expect(openTabChannel(name, null)).toBeNull();
	});
});
