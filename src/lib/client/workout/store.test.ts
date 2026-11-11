import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { deleteDB, openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import { createMutation } from '#lib/domain/workout/index.ts';
import type {
	LocalAction,
	LoggedSet,
	Mutation,
	MutationInput,
	MutationOf,
	MutationType,
	SyncResult
} from '#lib/domain/workout/index.ts';
import { replay } from '#lib/domain/workout/project.ts';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import { restRemaining, STOPWATCH_IDLE, stopwatchElapsed } from '#lib/domain/workout/timers.ts';
import type { WorkoutView } from '#lib/domain/workout/types.ts';
import { broadcast, openTabChannel } from './channel';
import { StoreClosedError } from './db';
import type { StoredWorkout } from './db';
import { DB_NAME, STORES } from './names';
import { STUCK_AFTER, type OutboxEntry } from './outbox-rules';
import { ACTIVE_WORKOUT_KEY } from './active-flag';
import { PREPAINT_KEY, writePrepaint, type PrepaintCard } from './prepaint';
import { activeSummary, pendingCount, waitingToSync } from './probe';
import { ActiveWorkoutError, createStore, PRUNE_AFTER, requestPersistence } from './store';
import type { WorkoutStore } from './store';

const KIT = workoutDayKits({ date: '2026-11-06' }).strength;
const T0 = Date.parse('2026-11-06T18:00:00.000Z');
const W = '00000000-0000-4000-8000-0000000000a1';
const W2 = '00000000-0000-4000-8000-0000000000a2';
const W3 = '00000000-0000-4000-8000-0000000000a3';
const DAY = 24 * 60 * 60 * 1000;

let clock = T0;
let ids = 0;
const fresh = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;
const iso = (ms = clock) => new Date(ms).toISOString();

function make<T extends MutationType>(
	type: T,
	input: Omit<MutationInput<T>, 'at' | 'workoutId'> & { workoutId?: string }
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
const finish = (workoutId = W) => make('workout.finish', { workoutId, payload: {} });

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

const goTo = (position: number, workoutId = W): LocalAction => ({
	type: 'goTo',
	workoutId,
	position
});

const open = () => createStore({ table: strengthTable, now: () => clock, random: () => 0.5 });

/** A started workout, written. */
async function started(store: WorkoutStore, workoutId = W) {
	expect(await store.dispatch(start(workoutId), attach(workoutId)).saved).toBe('saved');
}

/** What the database holds, read past the store. */
async function stored() {
	const db = await openDB(DB_NAME);
	const workouts = (await db.getAll(STORES.workouts)) as StoredWorkout[];
	const outbox = (await db.getAll(STORES.outbox)) as OutboxEntry[];
	const kits = await db.getAll(STORES.kits);
	db.close();
	return { workouts, outbox, kits, ids: outbox.map((e) => e.envelope.id) };
}

const setIds = (view: WorkoutView | null | undefined) =>
	view!.slots.flatMap((slot) => slot.sets.map((s) => s.id));

/** The server's rows after it applied `mutations`: the same reducers on the canonical shape. */
const serverRows = (workoutId: string, mutations: Mutation[]) =>
	replay(strengthTable, { workoutId, kit: KIT, canonical: null, pending: mutations }).rows!;

/** A sync response that applied every mutation, the last carrying the workout's rows. */
const appliedAll = (workoutId: string, mutations: Mutation[]): SyncResult[] =>
	mutations.map((m, i) => ({
		id: m.id,
		status: 'applied',
		...(i === mutations.length - 1 ? { canonical: serverRows(workoutId, mutations) } : {})
	}));

const quota = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError');

beforeEach(() => {
	vi.stubGlobal('indexedDB', new IDBFactory());
	clock = T0;
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('dispatch', () => {
	it('shows the action in the same frame, then writes its outbox entry and its state together', async () => {
		const store = await open();
		await started(store);
		const changes: unknown[] = [];
		store.onChange((change) => changes.push(change));
		const logged = store.dispatch(log('s1', 1), goTo(2));

		expect(changes).toEqual([{ type: 'view', workoutId: W }]);
		expect(setIds(logged.snapshot.view)).toEqual(['s1']);
		expect(logged.snapshot.view!.device.position).toBe(2);

		expect(await logged.saved).toBe('saved');
		expect(changes).toEqual([
			{ type: 'view', workoutId: W },
			{ type: 'saved', workoutId: W }
		]);
		const db = await stored();
		expect(db.ids).toEqual([W, 's1']);
		expect(db.workouts).toHaveLength(1);
		expect(db.workouts[0]!.device.position).toBe(2);
		expect(db.workouts[0]!.kit).toStrictEqual(KIT);
		expect(db.workouts[0]).toMatchObject({ id: W, status: 'in_progress', title: KIT.title });
	});

	it('writes neither the outbox entry nor the state when the transaction aborts', async () => {
		const store = await open();
		await started(store);
		vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
			throw new DOMException('Could not be cloned.', 'DataCloneError');
		});

		const logged = store.dispatch(log('s1', 1), goTo(2));
		expect(await logged.saved).toBe('not-saved');

		const db = await stored();
		expect(db.ids).toEqual([W]);
		expect(db.workouts[0]!.device.position).toBe(1);
		const reloaded = await (await open()).getActive();
		expect(setIds(reloaded!.view)).toEqual([]);
	});

	it('writes a follow-up local action with its mutation, or neither', async () => {
		const store = await open();
		await started(store);
		const rest: LocalAction = { type: 'rest.start', workoutId: W, at: clock, durationMs: 90_000 };
		expect(await store.dispatch(log('s1', 1), rest).saved).toBe('saved');
		let db = await stored();
		expect(db.ids).toEqual([W, 's1']);
		expect(db.workouts[0]!.device.rest).toMatchObject({ startedAt: T0, durationMs: 90_000 });

		vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementationOnce(() => {
			throw quota();
		});
		const next = store.dispatch(log('s2', 2), goTo(2));
		expect(await next.saved).toBe('not-saved');
		db = await stored();
		expect(db.ids).toEqual([W, 's1']);
		expect(db.workouts[0]!.device.position).toBe(1);
	});

	it('writes two mutations of one action atomically: an exercise.create and its substitution', async () => {
		const store = await open();
		await started(store);
		const created = make('exercise.create', {
			payload: {
				name: 'Sandbag shouldering',
				aliases: [],
				pattern: 'carry',
				primaryMuscles: ['glutes'],
				secondaryMuscles: [],
				equipment: [],
				substitutionGroup: null,
				skillLevel: 'beginner',
				repMin: 3,
				repMax: 8,
				defaultSeconds: null,
				unilateral: false,
				measure: 'reps',
				loadType: 'external',
				tags: [],
				disciplines: []
			}
		});
		const swapped = make('exercise.substitute', {
			payload: {
				position: 2,
				plannedLineage: KIT.exercises[1]!.plannedLineage,
				fromExerciseId: KIT.exercises[1]!.exercise.id,
				toExerciseId: created.entityId,
				reason: 'equipment_unavailable'
			}
		});
		// The first add (the exercise) succeeds; the second (its substitution) hits the quota.
		const add = IDBObjectStore.prototype.add;
		vi.spyOn(IDBObjectStore.prototype, 'add')
			.mockImplementationOnce(function (this: IDBObjectStore, ...args) {
				return add.apply(this, args);
			})
			.mockImplementationOnce(() => {
				throw quota();
			});
		expect(await store.dispatch(created, swapped).saved).toBe('not-saved');
		expect((await stored()).ids).toEqual([W]);

		vi.restoreAllMocks();
		expect(await store.retry(created.id)).toBe('saved');
		expect((await stored()).ids).toEqual([W, created.id, swapped.id]);
	});

	it('refuses actions for a workout it has not loaded, and actions naming two workouts', async () => {
		const store = await open();
		expect(() => store.dispatch(log('s1', 1))).toThrow(RangeError);
		await started(store);
		expect(() => store.dispatch(log('s1', 1), goTo(2, W2))).toThrow(RangeError);
		expect(store.snapshot(W)!.view!.slots[0]!.sets).toEqual([]);
	});
});

describe('restore', () => {
	it('projects exactly the same view after a reload, timers and current exercise included, with no network', async () => {
		const network = vi.fn(() => Promise.reject(new Error('offline')));
		vi.stubGlobal('fetch', network);
		const store = await open();
		await started(store);
		store.dispatch(log('s1', 1), { type: 'rest.start', workoutId: W, at: T0, durationMs: 120_000 });
		store.dispatch({ type: 'stopwatch.start', workoutId: W, at: T0 - 60_000 });
		store.dispatch(log('s2', 1, { position: 2 }));
		store.dispatch(goTo(3), {
			type: 'draft',
			workoutId: W,
			position: 3,
			setIndex: 1,
			draft: { weight: 60 }
		});
		const last = store.dispatch({ type: 'rest.pause', workoutId: W, at: T0 + 30_000 });
		expect(await last.saved).toBe('saved');
		const before = store.snapshot(W)!.view;

		const reloaded = await (await open()).getActive();

		expect(reloaded!.view).toStrictEqual(before);
		const device = reloaded!.view!.device;
		expect(device.position).toBe(3);
		expect(device.drafts).toEqual({ '3:1': { weight: 60 } });
		expect(restRemaining(device.rest!, T0 + 10 * 60_000)).toBe(90_000);
		expect(stopwatchElapsed(device.stopwatch, T0 + 60_000)).toBe(120_000);
		expect(setIds(reloaded!.view)).toEqual(['s1', 's2']);
		expect(network).not.toHaveBeenCalled();
	});

	it('finds no active workout on an empty device, or once the workout is finished', async () => {
		const store = await open();
		expect(await store.getActive()).toBeNull();
		await started(store);
		expect((await (await open()).getActive())!.workoutId).toBe(W);
		expect(await store.dispatch(finish()).saved).toBe('saved');
		expect(await (await open()).getActive()).toBeNull();
	});
});

describe('two tabs on one database', () => {
	it('loses no set and keeps each tab’s order when they dispatch interleaved', async () => {
		const a = await open();
		await started(a);
		const b = await open();
		expect((await b.getActive())!.workoutId).toBe(W);

		for (let i = 1; i <= 4; i++) {
			const tab = i % 2 === 1 ? a : b;
			expect(await tab.dispatch(log(`s${i}`, i)).saved).toBe('saved');
		}
		expect((await stored()).ids).toEqual([W, 's1', 's2', 's3', 's4']);
		// Each write also reads what the other tab wrote.
		expect(setIds(b.snapshot(W)!.view)).toEqual(['s1', 's2', 's3', 's4']);

		const burst = [
			a.dispatch(log('s5', 5)),
			b.dispatch(log('s6', 6)),
			a.dispatch(log('s7', 7)),
			b.dispatch(log('s8', 8))
		];
		expect(await Promise.all(burst.map((d) => d.saved))).toEqual(Array(4).fill('saved'));

		const { ids: queued } = await stored();
		expect(queued).toHaveLength(9);
		expect(new Set(queued).size).toBe(9);
		expect(queued.indexOf('s5')).toBeLessThan(queued.indexOf('s7'));
		expect(queued.indexOf('s6')).toBeLessThan(queued.indexOf('s8'));
		const reloaded = await (await open()).getActive();
		expect(setIds(reloaded!.view).sort()).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']);
	});
});

describe('closing', () => {
	it('closes on a deletion, which completes unblocked, and never writes or reopens after it', async () => {
		const store = await open();
		await started(store);
		const changes: unknown[] = [];
		store.onChange((change) => changes.push(change));
		let blocked = false;

		await deleteDB(DB_NAME, { blocked: () => (blocked = true) });

		expect(blocked).toBe(false);
		expect(store.closed).toBe('deleted');
		expect(changes).toContainEqual({ type: 'closed', reason: 'deleted' });
		expect(() => store.dispatch(log('s1', 1))).toThrow(StoreClosedError);
		await expect(store.load(W)).rejects.toThrow(StoreClosedError);
		await expect(open()).rejects.toThrow(StoreClosedError);
		expect(await indexedDB.databases()).toEqual([]);
	});

	it('tells an upgrade by a newer app from a deletion', async () => {
		const store = await open();
		await started(store);

		const newer = await openDB(DB_NAME, 2);
		newer.close();

		expect(store.closed).toBe('upgraded');
		let refused: unknown;
		try {
			store.dispatch(log('s1', 1));
		} catch (error) {
			refused = error;
		}
		expect(refused).toBeInstanceOf(StoreClosedError);
		expect((refused as StoreClosedError).reason).toBe('upgraded');
	});

	it("another tab's sign-out closes this page for good: it never recreates the deleted database", async () => {
		const name = 'pc-workout-store-signed-out-test';
		const stale = await createStore({ table: strengthTable, channel: openTabChannel(name) });
		await started(stale);

		broadcast({ type: 'signed-out' }, name);
		await vi.waitFor(() => expect(stale.closed).toBe('deleted'));
		// What signOut does next (clearIndexedDb): never blocked by this page.
		let blocked = false;
		await deleteDB(DB_NAME, { blocked: () => (blocked = true) });

		expect(blocked).toBe(false);
		await expect(open()).rejects.toMatchObject({ name: 'StoreClosedError', reason: 'deleted' });
		expect(await indexedDB.databases()).toEqual([]);
	});

	it('close lets go of the store, not the page: a store opened next reads the database', async () => {
		const store = await open();
		await started(store);
		const changes: unknown[] = [];
		store.onChange((change) => changes.push(change));

		store.close();

		expect(store.closed).toBe('deleted');
		expect(changes).toContainEqual({ type: 'closed', reason: 'deleted' });
		expect(() => store.dispatch(log('s1', 1))).toThrow(StoreClosedError);
		const next = await open();
		expect((await next.getActive())!.workoutId).toBe(W);
		expect(await next.dispatch(log('s1', 1)).saved).toBe('saved');
	});

	it('reads a database a newer app has already upgraded as upgraded', async () => {
		(await openDB(DB_NAME, 2)).close();
		await expect(open()).rejects.toMatchObject({ name: 'StoreClosedError', reason: 'upgraded' });
	});
});

describe('the database', () => {
	it('deletes and recreates a database with the wrong stores', async () => {
		const foreign = await openDB(DB_NAME, 1, {
			upgrade: (db) => db.createObjectStore('sets').put({ reps: 5 }, 1)
		});
		foreign.close();

		const store = await open();
		await started(store);

		const db = await openDB(DB_NAME);
		expect([...db.objectStoreNames].sort()).toEqual(Object.values(STORES).sort());
		db.close();
		expect((await stored()).ids).toEqual([W]);
	});
});

describe('one active workout', () => {
	it('refuses a second while one is in progress, in this tab and from a tab that never loaded it', async () => {
		const store = await open();
		await started(store);
		expect(() => store.dispatch(start(W2), attach(W2))).toThrow(ActiveWorkoutError);
		expect(store.snapshot(W2)).toBeNull();

		const other = await open();
		const second = other.dispatch(start(W2), attach(W2));
		expect(await second.saved).toBe('refused');
		expect(other.snapshot(W2)).toBeNull();
		const db = await stored();
		expect(db.ids).toEqual([W]);
		expect(db.workouts.map((w) => w.id)).toEqual([W]);

		expect(await store.dispatch(finish()).saved).toBe('saved');
		await started(store, W2);
		expect((await store.getActive())!.workoutId).toBe(W2);
	});
});

describe('sync responses', () => {
	it('removes acknowledged entries, parks a refusal and stores the canonical rows, in one transaction', async () => {
		const store = await open();
		const sent = [start(), log('s1', 1), log('s2', 2)];
		store.dispatch(sent[0]!, attach());
		store.dispatch(sent[1]!);
		expect(await store.dispatch(sent[2]!).saved).toBe('saved');

		await store.acknowledge([
			...appliedAll(W, sent.slice(0, 2)),
			{ id: 's2', status: 'rejected', code: 'invalid', errors: { 'payload.reps': 'Too many' } }
		]);

		const db = await stored();
		expect(db.ids).toEqual(['s2']);
		expect(db.outbox[0]!.parked).toEqual({
			reason: 'refused',
			errors: { 'payload.reps': 'Too many' },
			message: 'A value is not valid'
		});
		expect(db.workouts[0]!.canonical).toStrictEqual(serverRows(W, sent.slice(0, 2)));
		const sets = store.snapshot(W)!.view!.slots[0]!.sets;
		expect(sets.map((s) => [s.id, s.pending])).toEqual([
			['s1', false],
			['s2', true]
		]);
		expect((await (await open()).getActive())!.view).toStrictEqual(store.snapshot(W)!.view);
	});

	it('lists the workouts with changes waiting', async () => {
		const store = await open();
		expect(await store.listUnsynced()).toEqual([]);
		await started(store);
		expect(await store.dispatch(log('s1', 1)).saved).toBe('saved');
		expect(await store.listUnsynced()).toEqual([
			{
				workoutId: W,
				pending: 2,
				workout: { kind: 'strength', title: KIT.title, startedAt: iso(T0), status: 'in_progress' }
			}
		]);
	});
});

describe('prune', () => {
	it('lets a workout finished here go once its last change is acknowledged, and only then', async () => {
		const store = await open();
		const sent = [start(W), log('s1', 1), finish(W)];
		store.dispatch(sent[0]!, attach(W));
		store.dispatch(sent[1]!);
		expect(await store.dispatch(sent[2]!).saved).toBe('saved');
		const abandoned = [start(W2), make('workout.abandon', { workoutId: W2, payload: {} })];
		store.dispatch(abandoned[0]!, attach(W2));
		expect(await store.dispatch(abandoned[1]!).saved).toBe('saved');
		const changes: unknown[] = [];
		store.onChange((change) => changes.push(change));

		await store.acknowledge(appliedAll(W, sent.slice(0, 2)));
		expect((await stored()).workouts.map((w) => w.id).sort()).toEqual([W, W2]);
		expect(store.snapshot(W)?.view?.workout.status).toBe('completed');

		const finished: SyncResult = {
			id: sent[2]!.id,
			status: 'applied',
			canonical: serverRows(W, sent)
		};
		await store.acknowledge([finished, ...appliedAll(W2, abandoned)]);
		const db = await stored();
		expect(db.workouts).toEqual([]);
		expect(db.outbox).toEqual([]);
		expect(store.snapshot(W)).toBeNull();
		expect(store.snapshot(W2)).toBeNull();
		expect(changes).toContainEqual({ type: 'view', workoutId: W });
		expect(changes).toContainEqual({ type: 'view', workoutId: W2 });
	});

	it('removes a workout finished on another device after a day and kits after a week, never an unsynced workout', async () => {
		const store = await open();
		await store.saveKit(KIT.plannedLineage!, KIT);
		const begun = start(W);
		expect(await store.dispatch(begun, attach(W)).saved).toBe('saved');
		await store.acknowledge(appliedAll(W, [begun]));
		// Another device finished it: reconcile stores the server's rows, and nothing here waits.
		expect(await store.reconciled(serverRows(W, [begun, finish(W)]))).toBe(true);
		await started(store, W2);
		expect(await store.dispatch(finish(W2)).saved).toBe('saved'); // finished, never synced
		const active = start(W3);
		expect(await store.dispatch(active, attach(W3)).saved).toBe('saved');
		await store.acknowledge(appliedAll(W3, [active])); // in progress, synced

		clock = T0 + PRUNE_AFTER.finishedMs - 1;
		expect(await store.prune()).toEqual({ workouts: [], kits: [] });

		clock = T0 + PRUNE_AFTER.finishedMs;
		expect(await store.prune()).toEqual({ workouts: [W], kits: [] });
		expect(store.snapshot(W)).toBeNull();
		expect(await store.getKit(KIT.plannedLineage!)).toStrictEqual(KIT);

		clock = T0 + PRUNE_AFTER.kitMs;
		expect(await store.prune()).toEqual({ workouts: [], kits: [KIT.plannedLineage] });
		const db = await stored();
		expect(db.workouts.map((w) => w.id).sort()).toEqual([W2, W3]);
		expect(db.kits).toEqual([]);
		expect(await store.getKit(KIT.plannedLineage!)).toBeNull();
		expect(PRUNE_AFTER).toEqual({ finishedMs: DAY, kitMs: 7 * DAY });
	});
});

describe('storage errors', () => {
	it('keeps a set that hit the quota in the view, marked not saved, and Retry writes it once', async () => {
		const store = await open();
		await started(store);
		vi.spyOn(IDBObjectStore.prototype, 'add')
			.mockImplementationOnce(() => {
				throw quota();
			})
			.mockImplementationOnce(() => {
				throw quota();
			});

		const logged = store.dispatch(log('s1', 1));
		expect(await logged.saved).toBe('not-saved');
		const snapshot = store.snapshot(W)!;
		expect(setIds(snapshot.view)).toEqual(['s1']);
		expect(snapshot.notSaved).toEqual([{ id: 's1', entities: ['set:s1'], reason: 'quota' }]);
		expect((await stored()).ids).toEqual([W]);

		expect(await store.retry('s1')).toBe('not-saved'); // still full
		expect(store.snapshot(W)!.notSaved).toHaveLength(1);
		expect(await store.retry('s1')).toBe('saved');
		expect(await store.retry('s1')).toBe('saved');
		expect(store.snapshot(W)!.notSaved).toEqual([]);
		expect((await stored()).ids).toEqual([W, 's1']);
	});

	it('queues a mutation dispatched twice once, and goes on writing', async () => {
		const store = await open();
		await started(store);
		const twice = log('s1', 1);
		expect(await store.dispatch(twice).saved).toBe('saved');
		expect(await store.dispatch(twice).saved).toBe('saved');
		expect(await store.dispatch(log('s2', 2)).saved).toBe('saved');
		expect((await stored()).ids).toEqual([W, 's1', 's2']);
	});

	it('writes a change that was not saved before the next one, in order', async () => {
		const store = await open();
		await started(store);
		vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementationOnce(() => {
			throw quota();
		});
		expect(await store.dispatch(log('s1', 1)).saved).toBe('not-saved');
		expect(await store.dispatch(log('s2', 2)).saved).toBe('saved');
		expect((await stored()).ids).toEqual([W, 's1', 's2']);
		expect(store.snapshot(W)!.notSaved).toEqual([]);
	});

	it('asks for persistent storage, best effort', async () => {
		expect(await requestPersistence({ persist: () => Promise.resolve(true) })).toBe(true);
		expect(await requestPersistence({ persist: () => Promise.reject(new Error('denied')) })).toBe(
			false
		);
		expect(await requestPersistence(undefined)).toBe(false);
	});
});

describe('the probe', () => {
	it('creates nothing on a device without the database', async () => {
		expect(await activeSummary()).toBeNull();
		expect(await pendingCount()).toBe(0);
		expect(await indexedDB.databases()).toEqual([]);
	});

	it('reads the active workout and the changes waiting, and never holds the database open', async () => {
		const store = await open();
		await started(store);
		expect(await store.dispatch(log('s1', 1)).saved).toBe('saved');
		const close = vi.spyOn(IDBDatabase.prototype, 'close');

		expect(await activeSummary()).toEqual({
			workoutId: W,
			kind: 'strength',
			title: KIT.title,
			startedAt: iso(T0),
			plannedLineage: KIT.plannedLineage,
			pending: 2,
			stopwatch: STOPWATCH_IDLE
		});
		expect(await pendingCount()).toBe(2);
		expect(await store.dispatch(finish()).saved).toBe('saved');
		expect(await activeSummary()).toBeNull();
		expect(await pendingCount()).toBe(3);
		expect(close).toHaveBeenCalledTimes(4); // once per read

		let blocked = false;
		await deleteDB(DB_NAME, { blocked: () => (blocked = true) });
		expect(blocked).toBe(false);
	});

	it('lists the finished workouts with changes waiting, newest first, until they sync', async () => {
		const store = await open();
		const first = [start(W), log('s1', 1, { workoutId: W }), finish(W)];
		store.dispatch(first[0]!, attach(W));
		store.dispatch(first[1]!);
		expect(await store.dispatch(first[2]!).saved).toBe('saved');
		clock = T0 + 60_000;
		const second = [start(W2), finish(W2)];
		store.dispatch(second[0]!, attach(W2));
		expect(await store.dispatch(second[1]!).saved).toBe('saved');
		await started(store, W3); // in progress: the resume bar's, not History's

		const row = (workoutId: string, startedAt: string, pending: number) => ({
			workoutId,
			kind: 'strength',
			title: KIT.title,
			startedAt,
			pending
		});
		expect(await waitingToSync()).toEqual([row(W2, iso(T0 + 60_000), 2), row(W, iso(T0), 3)]);

		await store.acknowledge(appliedAll(W2, second));
		expect(await waitingToSync()).toEqual([row(W, iso(T0), 3)]);
		await store.acknowledge(appliedAll(W, first));
		expect(await waitingToSync()).toEqual([]);
	});

	it('lists nothing, and creates nothing, on a device without the database', async () => {
		expect(await waitingToSync()).toEqual([]);
		expect(await indexedDB.databases()).toEqual([]);
	});

	it('closes at once when sign-out deletes the database during a read', async () => {
		await started(await open());
		const reading = activeSummary();
		let blocked = false;

		await deleteDB(DB_NAME, { blocked: () => (blocked = true) });

		expect(blocked).toBe(false);
		const summary = await reading; // what it read before the deletion, or nothing; never an error
		expect(summary === null || summary.workoutId === W).toBe(true);
		expect(await indexedDB.databases()).toEqual([]);
	});

	it("reads M2's 'pc-offline' with a single 'sets' store as empty, and the store recreates it", async () => {
		const foreign = await openDB(DB_NAME, 1, { upgrade: (db) => db.createObjectStore('sets') });
		foreign.close();

		expect(await activeSummary()).toBeNull();
		expect(await pendingCount()).toBe(0);

		await started(await open());
		const db = await openDB(DB_NAME);
		expect([...db.objectStoreNames].sort()).toEqual(Object.values(STORES).sort());
		db.close();
		expect(await pendingCount()).toBe(1);
	});
});

describe("the owner's answers to a change that needs attention", () => {
	const edit = (id: string, reps: number) =>
		make('set.edit', { entityId: id, payload: { ...done, reps } });

	it('Discard removes the change and its dependants in one write, shows it, and keeps their ids to send', async () => {
		const store = await open();
		await started(store);
		const refused = log('s1', 1);
		const later = edit('s1', 4);
		store.dispatch(refused);
		store.dispatch(log('s2', 2));
		expect(await store.dispatch(later).saved).toBe('saved');
		await store.acknowledge([{ id: 's1', status: 'rejected', code: 'invalid' }]);
		const changes: unknown[] = [];
		store.onChange((change) => changes.push(change));

		const seq = (await store.outbox()).find((e) => e.envelope.id === 's1')!.seq;
		await store.discard(seq);

		expect((await stored()).ids).toEqual([W, 's2']);
		expect(setIds(store.snapshot(W)!.view)).toEqual(['s2']);
		expect(changes).toEqual([{ type: 'view', workoutId: W }]);
		expect(await store.discarded()).toEqual(['s1', later.id]);
		expect((await (await open()).getActive())!.view).toStrictEqual(store.snapshot(W)!.view);

		// A lost session keeps them: they are the device's to send.
		await store.purgeServerCopies();
		expect(await store.discarded()).toEqual(['s1', later.id]);
		await store.forget(['s1']);
		expect(await store.discarded()).toEqual([later.id]);
	});

	it('Discard of a refused start takes its workout off the device, so another can start', async () => {
		const store = await open();
		await started(store);
		expect(await store.dispatch(log('s1', 1)).saved).toBe('saved');
		await store.acknowledge([{ id: W, status: 'rejected', code: 'invalid' }]);

		await store.discard((await store.outbox())[0]!.seq);

		expect(await stored()).toMatchObject({ workouts: [], outbox: [] });
		expect(await store.discarded()).toEqual([W, 's1']);
		expect(await store.getActive()).toBeNull();
		await started(store, W2);
		expect((await store.getActive())!.workoutId).toBe(W2);
	});

	/** Parks an entry as stuck, the way a change that keeps failing is. */
	async function stuck(store: WorkoutStore, seq: number) {
		for (let i = 0; i < STUCK_AFTER.failures; i++) await store.countFailure(seq, 'timeout');
		expect((await store.outbox()).find((e) => e.seq === seq)!.parked?.reason).toBe('stuck');
	}

	it('refuses to discard a change that is not parked', async () => {
		const store = await open();
		await started(store);
		expect(await store.dispatch(log('s1', 1)).saved).toBe('saved');
		const before = await stored();

		for (const entry of await store.outbox()) {
			await expect(store.discard(entry.seq)).rejects.toThrow(
				new RangeError('Only a change that needs attention can be discarded')
			);
		}

		expect(await stored()).toEqual(before);
		expect(await store.discarded()).toEqual([]);
		expect((await store.getActive())!.workoutId).toBe(W);
	});

	it('Discard of a stuck start keeps the start and abandons the workout', async () => {
		const store = await open();
		await started(store);
		store.dispatch(log('s1', 1));
		expect(await store.dispatch(log('s2', 2)).saved).toBe('saved');
		const [entry] = await store.outbox();
		await stuck(store, entry!.seq);

		await store.discard(entry!.seq);

		const outbox = await store.outbox();
		expect(outbox.map((e) => e.envelope.type)).toEqual(['workout.start', 'workout.abandon']);
		expect(outbox[0]).toEqual({ ...entry, attempts: 0 });
		expect(outbox[0]!.parked).toBeUndefined();
		expect(outbox[1]!.envelope).toMatchObject({ workoutId: W, at: iso(), payload: {} });
		expect(outbox[1]!.seq).toBeGreaterThan(entry!.seq);
		expect((await stored()).workouts).toMatchObject([
			{ id: W, status: 'abandoned', finishedAt: iso() }
		]);
		expect(store.snapshot(W)!.view!.workout.status).toBe('abandoned');
		expect(await store.discarded()).toEqual(['s1', 's2']);
		expect(await store.getActive()).toBeNull();
	});

	it('a second Discard of a stuck start keeps the start and its abandon, both waiting', async () => {
		const store = await open();
		await started(store);
		expect(await store.dispatch(log('s1', 1)).saved).toBe('saved');
		const [entry] = await store.outbox();
		await stuck(store, entry!.seq);
		await store.discard(entry!.seq);
		const abandon = (await store.outbox())[1]!;
		// Both stuck now: the start may have landed, so neither may go, or the server keeps the
		// workout in progress for good.
		await stuck(store, entry!.seq);
		await stuck(store, abandon.seq);

		await store.discard(entry!.seq);

		const outbox = await store.outbox();
		expect(outbox).toEqual([
			{ ...entry, attempts: 0 },
			{ ...abandon, attempts: 0 }
		]);
		expect(outbox.filter((e) => e.parked)).toEqual([]);
		expect((await stored()).workouts).toMatchObject([{ id: W, status: 'abandoned' }]);
		expect(await store.discarded()).toEqual(['s1']);
		expect(await store.getActive()).toBeNull();
	});

	it('Discard of a start refused after an earlier Discard deletes it with its abandon', async () => {
		const store = await open();
		await started(store);
		expect(await store.dispatch(log('s1', 1)).saved).toBe('saved');
		const [entry] = await store.outbox();
		await stuck(store, entry!.seq);
		await store.discard(entry!.seq);
		const abandon = (await store.outbox())[1]!.envelope;
		// The server answered this time and refused it, so it never landed.
		await store.acknowledge([{ id: W, status: 'rejected', code: 'invalid' }]);

		await store.discard(entry!.seq);

		expect(await stored()).toMatchObject({ workouts: [], outbox: [] });
		expect(await store.discarded()).toEqual(['s1', W, abandon.id]);
		expect(await store.getActive()).toBeNull();
		await started(store, W2);
		expect((await store.getActive())!.workoutId).toBe(W2);
	});

	it('Fix re-queues the corrected change in its place under its id; Try again unparks a stuck one', async () => {
		const store = await open();
		await started(store);
		store.dispatch(log('s1', 1));
		expect(await store.dispatch(log('s2', 2)).saved).toBe('saved');
		await store.acknowledge([{ id: 's1', status: 'rejected', code: 'invalid' }]);
		const [, first, second] = await store.outbox();
		for (let i = 0; i < STUCK_AFTER.failures; i++) {
			await store.countFailure(second!.seq, 'The server answered 500');
		}
		expect((await store.outbox())[2]!.parked?.reason).toBe('stuck');

		const fixed = {
			...first!.envelope,
			payload: { ...first!.envelope.payload, reps: 3 }
		} as Mutation;
		await store.fix(first!.seq, fixed);
		await store.tryAgain(second!.seq);

		const outbox = await store.outbox();
		expect(outbox.map((e) => [e.seq, e.envelope.id])).toEqual([
			[outbox[0]!.seq, W],
			[first!.seq, 's1'],
			[second!.seq, 's2']
		]);
		expect(outbox[1]).toEqual({ ...first, envelope: fixed, parked: undefined, attempts: 0 });
		expect(outbox[1]!.parked).toBeUndefined();
		expect(outbox[2]).toEqual({ ...second, attempts: 0 });
		expect(store.snapshot(W)!.view!.slots[0]!.sets[0]!.reps).toBe(3);
		await expect(store.fix(first!.seq, { ...fixed, id: 's9' })).rejects.toThrow(RangeError);
		expect(await store.discarded()).toEqual([]);
	});

	it('a stripped workout ends when it is abandoned, so another can start', async () => {
		const store = await open();
		await started(store);
		await store.acknowledge(appliedAll(W, [start()])); // a start's id is its workout's
		await store.purgeServerCopies();
		const abandon = make('workout.abandon', { payload: {} });

		expect(await store.dispatch(abandon).saved).toBe('saved');

		expect(await store.getActive()).toBeNull();
		const db = await stored();
		expect(db.ids).toEqual([abandon.id]);
		expect(db.workouts[0]).toMatchObject({ id: W, status: 'abandoned', finishedAt: abandon.at });
		await started(store, W2);
		expect((await store.getActive())!.workoutId).toBe(W2);
	});

	it('Discard never brings a workout back into progress beside another', async () => {
		const store = await open();
		await started(store);
		await store.acknowledge(appliedAll(W, [start()]));
		const abandon = make('workout.abandon', { payload: {} });
		expect(await store.dispatch(abandon).saved).toBe('saved');
		await started(store, W2);
		await store.acknowledge([{ id: abandon.id, status: 'rejected', code: 'invalid' }]);
		const abandonSeq = (await store.outbox()).find((e) => e.envelope.id === abandon.id)!.seq;

		await expect(store.discard(abandonSeq)).rejects.toBeInstanceOf(ActiveWorkoutError);
		await expect(store.discard(abandonSeq)).rejects.toMatchObject({ workoutId: W2 });

		const db = await stored();
		expect(db.ids).toContain(abandon.id);
		expect(db.workouts.find((w) => w.id === W)!.status).toBe('abandoned');
		expect(await store.discarded()).toEqual([]);
		expect((await store.getActive())!.workoutId).toBe(W2);
	});

	/** W synced, then stripped by a 401 purge: the server holds it in progress, the device no rows. */
	async function strippedWorkout(store: WorkoutStore) {
		await started(store);
		await store.acknowledge(appliedAll(W, [start()]));
		await store.purgeServerCopies();
	}

	it.each([
		['abandon', 'stuck', 'abandoned'],
		['abandon', 'refused', 'abandoned'],
		['finish', 'stuck', 'completed'],
		['finish', 'refused', 'completed']
	] as const)(
		'refuses to discard the parked %s (%s) of a workout a sign-out stripped, and keeps it to sync',
		async (type, reason, status) => {
			const store = await open();
			await strippedWorkout(store);
			const end = type === 'abandon' ? make('workout.abandon', { payload: {} }) : finish();
			expect(await store.dispatch(end).saved).toBe('saved');
			const seq = (await store.outbox()).find((e) => e.envelope.id === end.id)!.seq;
			if (reason === 'stuck') await stuck(store, seq);
			else await store.acknowledge([{ id: end.id, status: 'rejected', code: 'invalid' }]);
			expect(await store.heldEnds()).toEqual(new Set([seq]));
			const before = await stored();

			await expect(store.discard(seq)).rejects.toThrow(
				new RangeError('The end of a workout the server holds waits for the server')
			);

			expect(await stored()).toEqual(before);
			expect(before.ids).toEqual([end.id]);
			expect(before.workouts).toMatchObject([{ id: W, status }]);
			expect(await store.discarded()).toEqual([]);
			if (reason === 'stuck') {
				await store.tryAgain(seq);
				expect((await store.outbox())[0]!.parked).toBeUndefined();
			}
		}
	);

	it('keeps a stripped workout’s abandon queued when a change it depends on is discarded', async () => {
		const store = await open();
		await strippedWorkout(store);
		const notes = make('workout.update', { entityId: W, payload: { notes: 'Heavy' } });
		const abandon = make('workout.abandon', { payload: {} });
		store.dispatch(notes);
		expect(await store.dispatch(abandon).saved).toBe('saved');
		await store.acknowledge([{ id: notes.id, status: 'rejected', code: 'invalid' }]);
		const [update, end] = await store.outbox();
		expect(await store.heldEnds()).toEqual(new Set([end!.seq]));

		await store.discard(update!.seq);

		expect(await store.outbox()).toEqual([end]);
		expect(await store.discarded()).toEqual([notes.id]);
		expect((await stored()).workouts).toMatchObject([{ id: W, status: 'abandoned' }]);
	});

	it('refuses to discard the parked end of a workout a sign-out took off the device', async () => {
		const store = await open();
		await started(store);
		await store.acknowledge(appliedAll(W, [start()]));
		const abandon = make('workout.abandon', { payload: {} });
		expect(await store.dispatch(abandon).saved).toBe('saved');
		await store.purgeServerCopies(); // an ended workout leaves; its abandon stays to send
		const [end] = await store.outbox();
		await store.acknowledge([{ id: abandon.id, status: 'rejected', code: 'invalid' }]);
		expect((await stored()).workouts).toEqual([]);
		expect(await store.heldEnds()).toEqual(new Set([end!.seq]));

		await expect(store.discard(end!.seq)).rejects.toThrow(RangeError);

		expect((await stored()).ids).toEqual([abandon.id]);
		expect(await store.discarded()).toEqual([]);
	});

	it('Discard of the parked abandon of a workout the device holds rows for works as before', async () => {
		const store = await open();
		await started(store);
		await store.acknowledge(appliedAll(W, [start()]));
		const abandon = make('workout.abandon', { payload: {} });
		expect(await store.dispatch(abandon).saved).toBe('saved');
		await store.acknowledge([{ id: abandon.id, status: 'rejected', code: 'invalid' }]);
		const [end] = await store.outbox();
		expect(await store.heldEnds()).toEqual(new Set());

		await store.discard(end!.seq);

		const db = await stored();
		expect(db.ids).toEqual([]);
		expect(db.workouts).toMatchObject([{ id: W, status: 'in_progress' }]);
		expect(await store.discarded()).toEqual([abandon.id]);
	});

	it('Discard of the parked abandon of a stripped workout whose start is queued works as before', async () => {
		const store = await open();
		await started(store);
		await store.purgeServerCopies(); // its start is still queued: it makes the rows
		const abandon = make('workout.abandon', { payload: {} });
		expect(await store.dispatch(abandon).saved).toBe('saved');
		await store.acknowledge([{ id: abandon.id, status: 'rejected', code: 'invalid' }]);
		const end = (await store.outbox()).find((e) => e.envelope.id === abandon.id)!;
		expect(await store.heldEnds()).toEqual(new Set());

		await store.discard(end.seq);

		const db = await stored();
		expect(db.ids).toEqual([W]);
		expect(db.workouts).toMatchObject([{ id: W, status: 'in_progress' }]);
		expect(await store.discarded()).toEqual([abandon.id]);
	});

	it('Try again still works on a device that already holds two workouts in progress', async () => {
		const store = await open();
		await started(store);
		const raw = await openDB(DB_NAME);
		const record = (await raw.get(STORES.workouts, W)) as StoredWorkout;
		await raw.put(STORES.workouts, { ...record, id: W2, startedAt: iso(T0 + 60_000) });
		raw.close();
		const [entry] = await store.outbox();
		for (let i = 0; i < STUCK_AFTER.failures; i++) {
			await store.countFailure(entry!.seq, 'The server answered 500');
		}
		expect((await store.outbox())[0]!.parked?.reason).toBe('stuck');

		await store.tryAgain(entry!.seq);

		expect((await store.outbox())[0]!.parked).toBeUndefined();
		const workouts = (await stored()).workouts;
		expect(workouts.map((w) => w.status)).toEqual(['in_progress', 'in_progress']);
	});
});

describe("/workout's prepainted card", () => {
	const card = { name: 'Back squat' } as PrepaintCard;
	/** The page's localStorage, as a Map. */
	function pageStorage() {
		const map = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => map.get(key) ?? null,
			setItem: (key: string, value: string) => void map.set(key, value),
			removeItem: (key: string) => void map.delete(key)
		});
		return map;
	}
	const keep = () => writePrepaint({ workoutId: W, rest: false, card });

	it('is dropped by every change the store reports, before its listeners hear it', async () => {
		const storage = pageStorage();
		const store = await open();
		await started(store);
		const heard: (string | undefined)[] = [];
		store.onChange(() => heard.push(storage.get(PREPAINT_KEY)));

		keep();
		const logged = store.dispatch(log('s1', 1));
		expect(storage.has(PREPAINT_KEY)).toBe(false);
		keep();
		expect(await logged.saved).toBe('saved');
		expect(storage.has(PREPAINT_KEY)).toBe(false);
		expect(heard).toEqual([undefined, undefined]);

		keep();
		await store.dispatch(finish()).saved;
		expect(storage.has(PREPAINT_KEY)).toBe(false);
	});

	it('is dropped by a write of a workout this page has not loaded, which reports nothing', async () => {
		const storage = pageStorage();
		const begun = start(W);
		expect(await (await open()).dispatch(begun, attach(W)).saved).toBe('saved');
		const store = await open(); // another page: nothing in memory
		const changes: unknown[] = [];
		store.onChange((change) => changes.push(change));

		keep();
		expect(await store.reconciled(serverRows(W, [begun]))).toBe(true);
		expect(storage.has(PREPAINT_KEY)).toBe(false);
		// The server says another device finished it: the ack takes it off this device.
		keep();
		const rows = serverRows(W, [begun, finish(W)]);
		await store.acknowledge([{ id: begun.id, status: 'applied', canonical: rows }]);
		expect((await stored()).workouts).toEqual([]);
		expect(storage.has(PREPAINT_KEY)).toBe(false);
		expect(changes).toEqual([]);
	});

	it('waits for every change to be written here: its count of those still pending', async () => {
		const store = await open();
		await started(store);
		const logged = store.dispatch(log('s1', 1));
		expect(logged.snapshot.pending).toBe(1);
		expect(store.snapshot(W)!.pending).toBe(1);
		expect(await logged.saved).toBe('saved');
		expect(store.snapshot(W)!.pending).toBe(0);

		vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementationOnce(() => {
			throw quota();
		});
		expect(await store.dispatch(log('s2', 2)).saved).toBe('not-saved');
		expect(store.snapshot(W)!.pending).toBe(1);
	});

	it('is blocked by a lost session until the server answers as the owner again', async () => {
		const storage = pageStorage();
		const store = await open();
		await started(store);
		keep();

		await store.purgeServerCopies();
		const blocked = storage.get(PREPAINT_KEY);
		expect(JSON.parse(blocked!)).toEqual({ v: 1, blocked: true });
		keep();
		expect(await store.dispatch(log('s1', 1)).saved).toBe('saved');
		expect(storage.get(PREPAINT_KEY)).toBe(blocked);

		await store.signedIn();
		expect(storage.has(PREPAINT_KEY)).toBe(false);
		keep();
		expect(JSON.parse(storage.get(PREPAINT_KEY)!)).toMatchObject({ workoutId: W, card });
	});
});

describe('the launch flag (active-flag.ts)', () => {
	/** The page's localStorage, as a Map. */
	function pageStorage() {
		const map = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => map.get(key) ?? null,
			setItem: (key: string, value: string) => void map.set(key, value),
			removeItem: (key: string) => void map.delete(key)
		});
		return map;
	}
	const flagged = (storage: Map<string, string>) => {
		const flag = storage.get(ACTIVE_WORKOUT_KEY);
		return flag === undefined ? null : (JSON.parse(flag) as { workoutId: string; kind: string });
	};

	it('flags the workout in progress from its start, and drops the flag when it finishes', async () => {
		const storage = pageStorage();
		const store = await open();
		await started(store);
		expect(flagged(storage)).toEqual({ v: 1, workoutId: W, kind: 'strength' });
		expect(await store.dispatch(log('s1', 1)).saved).toBe('saved');
		expect(flagged(storage)).toMatchObject({ workoutId: W });

		expect(await store.dispatch(finish()).saved).toBe('saved');
		expect(flagged(storage)).toBeNull();
	});

	it('drops the flag when the workout is abandoned, or its refused start discarded', async () => {
		const storage = pageStorage();
		const store = await open();
		await started(store);
		expect(await store.dispatch(make('workout.abandon', { payload: {} })).saved).toBe('saved');
		expect(flagged(storage)).toBeNull();

		await started(store, W2);
		expect(flagged(storage)).toMatchObject({ workoutId: W2 });
		await store.acknowledge([{ id: W2, status: 'rejected', code: 'invalid' }]);
		expect(flagged(storage)).toMatchObject({ workoutId: W2 });
		const seq = (await store.outbox()).find((e) => e.envelope.id === W2)!.seq;
		await store.discard(seq);
		expect(flagged(storage)).toBeNull();
	});

	it('drops the flag when another device finished it, on a page that never loaded it', async () => {
		const storage = pageStorage();
		const begun = start(W);
		expect(await (await open()).dispatch(begun, attach(W)).saved).toBe('saved');
		const store = await open(); // another page: nothing in memory
		expect(await store.reconciled(serverRows(W, [begun]))).toBe(true);
		expect(flagged(storage)).toMatchObject({ workoutId: W });

		const rows = serverRows(W, [begun, finish(W)]);
		await store.acknowledge([{ id: begun.id, status: 'applied', canonical: rows }]);
		expect((await stored()).workouts).toEqual([]);
		expect(flagged(storage)).toBeNull();
	});

	it("never drops the workout in progress's flag for another workout leaving", async () => {
		const storage = pageStorage();
		const store = await open();
		const done = [start(W2), finish(W2)];
		store.dispatch(done[0]!, attach(W2));
		expect(await store.dispatch(done[1]!).saved).toBe('saved');
		await started(store);
		await store.acknowledge(appliedAll(W2, done));
		expect((await stored()).workouts.map((w) => w.id)).toEqual([W]);
		expect(flagged(storage)).toMatchObject({ workoutId: W });
	});

	it('getActive flags what IndexedDB holds: a workout kept before the flag, or none', async () => {
		const storage = pageStorage();
		await started(await open());
		storage.clear(); // a workout started before this build
		expect((await (await open()).getActive())!.workoutId).toBe(W);
		expect(flagged(storage)).toEqual({ v: 1, workoutId: W, kind: 'strength' });

		vi.stubGlobal('indexedDB', new IDBFactory()); // the browser evicted the database
		expect(await (await open()).getActive()).toBeNull();
		expect(flagged(storage)).toBeNull();
	});
});
