import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import type { Metric } from 'web-vitals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import type { FieldErrors } from '#lib/domain/validation.ts';
import { createMutation, dependsOn, entityKey, SYNC_LIMITS } from '#lib/domain/workout/index.ts';
import type {
	LocalAction,
	LoggedSet,
	Mutation,
	MutationInput,
	MutationOf,
	MutationType,
	SyncCode,
	SyncRequest,
	SyncResult
} from '#lib/domain/workout/index.ts';
import { replay } from '#lib/domain/workout/project.ts';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import type { StoredWorkout } from './db';
import { DB_NAME, STORES } from './names';
import { BACKOFF, nextDelay, STUCK_AFTER } from './outbox-rules';
import type { OutboxEntry } from './outbox-rules';
import { createStore } from './store';
import type { WorkoutStore } from './store';
import { REQUEST_TIMEOUT_MS, startSync, SYNC_LOCK, SYNC_URL } from './sync';
import type { SyncEngine, SyncLocks, SyncOptions } from './sync';

/** RUM's web-vitals, replaced so a test can queue metrics for vitals.ts's flush at hide. */
const vitals = vi.hoisted(() => ({ report: [] as ((metric: unknown) => void)[] }));
vi.mock('web-vitals', () => {
	const on = (report: (metric: unknown) => void) => void vitals.report.push(report);
	return { onCLS: on, onFCP: on, onINP: on, onLCP: on, onTTFB: on };
});

const KIT = workoutDayKits({ date: '2026-11-06' }).strength;
const T0 = Date.parse('2026-11-06T18:00:00.000Z');
const W = '00000000-0000-4000-8000-0000000000a1';
const W2 = '00000000-0000-4000-8000-0000000000a2';
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const KB = 1024;

let ids = 0;
const fresh = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;

// ---- The engine's clock, timers and randomness --------------------------------------------

/**
 * The engine's clock and timers, moved by hand. fake-indexeddb and the fake server keep the real
 * timers, so only what the engine schedules is controlled here.
 */
function manualClock() {
	let time = T0;
	let next = 0;
	const timers = new Map<number, { at: number; run: () => void }>();
	const delays: number[] = [];
	return {
		now: () => time,
		setTimeout: (run: () => void, ms: number) => {
			timers.set(++next, { at: time + ms, run });
			delays.push(ms);
			return next;
		},
		clearTimeout: (timer: unknown) => void timers.delete(timer as number),
		/** Every delay the engine asked for, in order. */
		delays,
		get pending() {
			return timers.size;
		},
		/** Moves the clock on by `ms`, running each timer that falls due on the way, in order. */
		advance(ms: number) {
			const end = time + ms;
			for (;;) {
				const due = [...timers]
					.filter(([, t]) => t.at <= end)
					.sort(([a, x], [b, y]) => x.at - y.at || a - b)[0];
				if (!due) break;
				timers.delete(due[0]);
				time = Math.max(time, due[1].at);
				due[1].run();
			}
			time = end;
		},
		/** The clock jumps (the device slept, the app was closed) with no timer running. */
		jump(ms: number) {
			time += ms;
		}
	};
}

/** mulberry32: the same draws for the same seed. */
function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const SEED = 7;

// ---- A fake server with its own ledger ----------------------------------------------------

/** What one request gets: an answer from the ledger, or a failure. */
type Step =
	| 'ok'
	| 500
	| 503
	| 401
	| 'passkey'
	| 'forbidden'
	/** The server applies the batch, then the answer is lost on the way back. */
	| 'lost'
	/** The server applies the batch, but answers with ids that are not the batch's. */
	| 'stranger'
	/** No answer, ever: only an abort ends it. */
	| 'hang'
	/** No answer, but the server goes on and applies the batch when the test says (landLate). */
	| 'late'
	/** Cancelled by the browser, as when the page is being left. */
	| 'cancelled'
	/** A captive portal or a dead gym Wi-Fi's gateway answers with its own page, not the server's JSON. */
	| 'portal'
	| 'gateway';

interface Received {
	ids: string[];
	discarded: string[];
	keepalive: boolean;
	bytes: number;
	signal: AbortSignal | undefined;
	url: string;
}

const encoder = new TextEncoder();
const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * POST /api/workouts/sync with M4's rules: a ledger of applied ids (a replay answers duplicate),
 * one result per mutation in order, a change whose target has not arrived deferred, a row's later
 * changes deferred once one of them is refused or deferred, and the canonical rows on the last
 * applied or duplicate result of each workout. Each set it applies is one row.
 */
function fakeServer() {
	const ledger = new Set<string>();
	const applied: Mutation[] = [];
	const created = new Set<string>();
	const received: Received[] = [];
	const answered: SyncResult[] = [];
	/** Refused for good, with these field errors. */
	const refuse = new Map<string, FieldErrors>();
	/** One step per request, in order; then 'ok'. */
	const script: Step[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	/** Real milliseconds each answer takes, so concurrent requests overlap. */
	let latency = 0;
	/** The batches the server is still running after the device stopped waiting ('late'). */
	const running: Mutation[][] = [];

	const rowsOf = (workoutId: string) =>
		replay(strengthTable, {
			workoutId,
			kit: null,
			canonical: null,
			pending: applied.filter((m) => m.workoutId === workoutId)
		}).rows;

	function apply(mutations: Mutation[]): SyncResult[] {
		const held: Mutation[] = [];
		const results = mutations.map((m): SyncResult => {
			const hold = (status: 'deferred' | 'rejected', code: SyncCode, errors?: FieldErrors) => {
				held.push(m);
				return { id: m.id, status, code, ...(errors ? { errors } : {}) };
			};
			if (ledger.has(m.id)) return { id: m.id, status: 'duplicate' };
			if (held.some((h) => dependsOn(m, h))) return hold('deferred', 'blocked');
			const errors = refuse.get(m.id);
			if (errors) return hold('rejected', 'invalid', errors);
			const edits = m.type === 'set.edit' || m.type === 'set.delete';
			if (
				(m.type !== 'workout.start' && !created.has(`workout:${m.workoutId}`)) ||
				(edits && !created.has(`set:${m.entityId}`))
			) {
				return hold('deferred', 'missing');
			}
			ledger.add(m.id);
			applied.push(m);
			if (m.id === m.entityId) created.add(entityKey(m));
			return { id: m.id, status: 'applied' };
		});
		const last = new Map<string, number>();
		results.forEach((r, i) => {
			if (r.status === 'applied' || r.status === 'duplicate') last.set(mutations[i]!.workoutId, i);
		});
		for (const [workoutId, i] of last) {
			const canonical = rowsOf(workoutId);
			if (canonical) results[i] = { ...results[i]!, canonical };
		}
		answered.push(...results);
		return results;
	}

	async function fetch(url: string, init: RequestInit): Promise<Response> {
		const body = init.body as string;
		const { mutations, discarded = [] } = JSON.parse(body) as SyncRequest;
		received.push({
			ids: mutations.map((m) => m.id),
			discarded,
			keepalive: init.keepalive === true,
			bytes: encoder.encode(body).length,
			signal: init.signal ?? undefined,
			url
		});
		const step = script.shift() ?? 'ok';
		// Claimed first, as the real server does: a request still carrying one answers duplicate.
		if (step === 'ok') for (const id of discarded) ledger.add(id);
		maxInFlight = Math.max(maxInFlight, ++inFlight);
		try {
			if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
			switch (step) {
				case 'hang':
					return await new Promise<never>((_, reject) =>
						init.signal!.addEventListener('abort', () =>
							reject(new DOMException('This operation was aborted', 'AbortError'))
						)
					);
				case 'late':
					running.push(mutations);
					return await new Promise<never>((_, reject) =>
						init.signal!.addEventListener('abort', () =>
							reject(new DOMException('This operation was aborted', 'AbortError'))
						)
					);
				case 'lost':
					apply(mutations);
					throw new TypeError('Failed to fetch');
				case 'stranger':
					return json(200, { v: 1, results: apply(mutations).map((r) => ({ ...r, id: fresh() })) });
				case 'cancelled':
					throw new TypeError('Load failed');
				case 'portal':
					return new Response('<!doctype html><title>Sign in to Gym-WiFi</title>', {
						status: 200,
						headers: { 'content-type': 'text/html' }
					});
				case 'gateway':
					return new Response('<html><body>502 Bad Gateway</body></html>', {
						status: 502,
						headers: { 'content-type': 'text/html' }
					});
				case 401:
					return json(401, { error: 'unauthenticated', message: 'Sign in to continue.' });
				case 'passkey':
					return json(403, { error: 'passkey_required', message: 'Add a new passkey.' });
				case 'forbidden':
					return json(403, { error: 'forbidden', message: 'Cross-site request refused.' });
				case 500:
				case 503:
					return json(step, { error: 'unavailable' });
				case 'ok':
					return json(200, { v: 1, results: apply(mutations) });
			}
		} finally {
			inFlight--;
		}
	}

	return {
		fetch,
		received,
		answered,
		refuse,
		script,
		rowsOf,
		/** The server reaches the batches it was still running ('late'), after everything else. */
		landLate: () => running.splice(0).map(apply),
		/** The rows a create made: one, however often its mutation arrived. */
		rows: (entityId: string) => applied.filter((m) => m.id === entityId).length,
		/** How often a mutation arrived, in any request. */
		arrivals: (id: string) => received.filter((r) => r.ids.includes(id)).length,
		set latency(ms: number) {
			latency = ms;
		},
		get maxInFlight() {
			return maxInFlight;
		}
	};
}

// ---- One device: Web Locks, the page's events ---------------------------------------------

/** navigator.locks for one device: exclusive, granted in the order asked. */
function fakeLocks(): SyncLocks & { names: string[] } {
	const tails = new Map<string, Promise<unknown>>();
	const names: string[] = [];
	return {
		names,
		request(name, callback) {
			names.push(name);
			const run = (tails.get(name) ?? Promise.resolve()).then(() => callback());
			tails.set(
				name,
				run.catch(() => {})
			);
			return run;
		}
	};
}

function fakePage() {
	const window = new EventTarget();
	const document = Object.assign(new EventTarget(), {
		visibilityState: 'visible' as DocumentVisibilityState
	});
	return { window, document };
}

// ---- Workouts ------------------------------------------------------------------------------

function make<T extends MutationType>(
	type: T,
	input: Omit<MutationInput<T>, 'at' | 'workoutId'> & { workoutId?: string }
): MutationOf<T> {
	return createMutation(
		type,
		{ workoutId: W, at: new Date(clock.now()).toISOString(), ...input },
		fresh
	);
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

function log(id: string, setIndex = 1, workoutId = W) {
	const slot = KIT.exercises[0]!;
	return make('set.log', {
		workoutId,
		entityId: id,
		payload: {
			position: 1,
			plannedLineage: slot.plannedLineage,
			setIndex,
			exerciseId: slot.exercise.id,
			...done
		}
	});
}
const edit = (id: string, reps: number, workoutId = W) =>
	make('set.edit', { workoutId, entityId: id, payload: { ...done, reps } });
const notes = (text: string, workoutId = W) =>
	make('workout.update', { workoutId, payload: { notes: text } });

// ---- The test bench -------------------------------------------------------------------------

let clock = manualClock();
let server = fakeServer();
let locks = fakeLocks();
let page = fakePage();
let online = true;
const engines: SyncEngine[] = [];

const open = () => createStore({ table: strengthTable, now: clock.now, random: () => 0.5 });

/** Written to IndexedDB, as every action is before anything touches the network. */
async function saved(
	store: WorkoutStore,
	...actions: [Mutation | LocalAction, ...(Mutation | LocalAction)[]]
) {
	const [action, ...followUps] = actions;
	expect(await store.dispatch(action, ...followUps).saved).toBe('saved');
}

/** A started workout with `sets` logged, all of it still in the outbox. */
async function withSets(store: WorkoutStore, ...sets: string[]) {
	await saved(store, start(), attach());
	for (const [i, id] of sets.entries()) await saved(store, log(id, i + 1));
}

/** startSync on this bench: it flushes at once, as at app start. */
function engine(store: WorkoutStore, options: Partial<SyncOptions> = {}): SyncEngine {
	const started = startSync({
		store,
		fetch: server.fetch,
		locks,
		now: clock.now,
		random: seeded(SEED),
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		online: () => online,
		events: page,
		leaving: () => false,
		...options
	});
	engines.push(started);
	return started;
}

async function outbox(): Promise<OutboxEntry[]> {
	const db = await openDB(DB_NAME);
	const entries = (await db.getAll(STORES.outbox)) as OutboxEntry[];
	db.close();
	return entries;
}
const outboxIds = async () => (await outbox()).map((e) => e.envelope.id);

/** Lets requests, IndexedDB and the engine's rounds run (they use the real event loop). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
/** Until `check` passes: what a timer or a released lock starts runs on the real event loop. */
const eventually = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 5 });

beforeEach(() => {
	vi.stubGlobal('indexedDB', new IDBFactory());
	clock = manualClock();
	server = fakeServer();
	locks = fakeLocks();
	page = fakePage();
	online = true;
});

afterEach(() => {
	for (const e of engines.splice(0)) e.stop();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

// ---- Delivery -------------------------------------------------------------------------------

describe('delivery', () => {
	it('sends the outbox in seq order, in batches within the caps, under the Web Lock', async () => {
		const store = await open();
		const sets = Array.from({ length: 30 }, (_, i) => `s${i + 1}`);
		await withSets(store, ...sets);
		const queued = await outboxIds();

		await engine(store).flush();

		expect(server.received.map((r) => r.ids.length)).toEqual([SYNC_LIMITS.maxMutations, 6]);
		expect(server.received.flatMap((r) => r.ids)).toEqual(queued);
		expect(server.received.every((r) => r.url === SYNC_URL && !r.keepalive)).toBe(true);
		expect(new Set(locks.names)).toEqual(new Set([SYNC_LOCK]));
		expect(await outbox()).toEqual([]);
		// The canonical rows are stored, so the view re-projects from them.
		const db = await openDB(DB_NAME);
		const [record] = (await db.getAll(STORES.workouts)) as StoredWorkout[];
		db.close();
		expect(record!.canonical).toStrictEqual(server.rowsOf(W));
		const shown = store.snapshot(W)!.view!.slots[0]!.sets;
		expect(shown.map((s) => [s.id, s.pending])).toEqual(sets.map((id) => [id, false]));
	});

	it('retries a 500 after the seeded backoff, and the server holds one row', async () => {
		const store = await open();
		await withSets(store, 's1');
		server.script.push(500);
		const sync = engine(store);
		await sync.flush();

		expect(server.received).toHaveLength(1);
		const [head] = await outbox();
		expect(head).toMatchObject({ attempts: 1, failingSince: T0 });
		const wait = nextDelay(0, seeded(SEED));
		expect(sync.status()).toEqual({
			state: 'retrying',
			seconds: Math.ceil(wait / 1000),
			pending: 2
		});

		await sync.flush(); // a dispatch's flush waits for the backoff
		clock.advance(wait - 1);
		await settle();
		expect(server.received).toHaveLength(1);

		clock.advance(1); // the engine's own timer sends it
		await eventually(() => expect(server.received).toHaveLength(2));
		await sync.flush();
		expect(server.rows('s1')).toBe(1);
		expect(await outbox()).toEqual([]);
		expect(sync.status()).toEqual({ state: 'synced' });
	});

	it('resends a response lost after the server committed: answered duplicate, acknowledged once', async () => {
		const store = await open();
		await withSets(store, 's1');
		server.script.push('lost');
		const sync = engine(store);
		await sync.flush();

		expect(server.rows('s1')).toBe(1); // committed, though the device never heard
		expect(await outboxIds()).toEqual([W, 's1']);
		expect((await outbox())[0]!.attempts).toBe(0); // the network lost it: nothing counted
		const acknowledge = vi.spyOn(store, 'acknowledge');

		clock.advance(nextDelay(0, seeded(SEED)));
		await sync.flush();

		expect(server.arrivals('s1')).toBe(2);
		expect(server.answered.filter((r) => r.id === 's1').map((r) => r.status)).toEqual([
			'applied',
			'duplicate'
		]);
		expect(server.rows('s1')).toBe(1);
		expect(acknowledge).toHaveBeenCalledTimes(1);
		expect(await outbox()).toEqual([]);
	});

	it('backs off on an answer whose ids are not the batch’s, instead of resending it at once', async () => {
		const store = await open();
		await withSets(store, 's1');
		server.script.push('stranger');
		const countFailure = vi.spyOn(store, 'countFailure');
		const sync = engine(store);
		await sync.flush();

		expect(server.received).toHaveLength(1);
		expect(countFailure).toHaveBeenCalledWith(1, 'The server answered nonsense');
		expect(sync.status()).toMatchObject({ state: 'retrying' });

		clock.advance(nextDelay(0, seeded(SEED)));
		await eventually(() => expect(server.received).toHaveLength(2));
		await sync.flush();
		expect(server.rows('s1')).toBe(1);
		expect(await outbox()).toEqual([]);
	});

	it('rejects on a transient IndexedDB error with the store open, and retries after the backoff', async () => {
		const store = await open();
		await withSets(store, 's1');
		const failure = new DOMException('Connection to Indexed Database server lost', 'UnknownError');
		vi.spyOn(store, 'acknowledge').mockRejectedValueOnce(failure);
		const sync = engine(store);
		await expect(sync.flush()).rejects.toBe(failure);
		expect(server.received).toHaveLength(1);

		clock.advance(nextDelay(0, seeded(SEED)));
		await eventually(() => expect(server.received).toHaveLength(2));
		await sync.flush();
		expect(server.rows('s1')).toBe(1);
		expect(await outbox()).toEqual([]);
	});

	it('aborts a request that never answers at 15 s, frees the lock, and retries after the backoff', async () => {
		const tabA = await open();
		await withSets(tabA, 's1');
		const tabB = await open();
		server.script.push('hang');
		const countFailure = vi.spyOn(tabA, 'countFailure');
		const a = engine(tabA);
		await eventually(() => expect(server.received).toHaveLength(1));
		const b = engine(tabB); // another tab: it waits for the lock
		await settle();
		expect(server.received).toHaveLength(1);

		clock.advance(REQUEST_TIMEOUT_MS - 1);
		await settle();
		expect(server.received[0]!.signal!.aborted).toBe(false);
		expect(server.received).toHaveLength(1);

		clock.advance(1);
		expect(server.received[0]!.signal!.aborted).toBe(true);
		// The server is out of reach, so nothing is counted, and the lock is free: the other tab
		// flushes at once.
		await eventually(() => expect(server.received).toHaveLength(2));
		expect(countFailure).not.toHaveBeenCalled();
		expect(server.received[1]!.ids).toEqual([W, 's1']);
		await b.flush();
		expect(server.rows('s1')).toBe(1);

		// A set logged meanwhile, during the first tab's backoff: it syncs once.
		await saved(tabA, log('s2', 2));
		await a.flush();
		expect(server.received).toHaveLength(2); // the first tab still backs off
		await b.flush();
		expect(server.received).toHaveLength(3);

		clock.advance(nextDelay(0, seeded(SEED)));
		await a.flush();
		expect(server.rows('s1')).toBe(1);
		expect(server.rows('s2')).toBe(1);
		expect(server.arrivals('s2')).toBe(1);
		expect(await outbox()).toEqual([]);
	});

	it('parks a refusal while a later independent change still flushes, and its dependants wait', async () => {
		const store = await open();
		server.refuse.set('s1', { 'payload.reps': 'Must be 50 or fewer' });
		await withSets(store, 's1', 's2');
		const sync = engine(store);
		await sync.flush();

		expect(server.rows('s2')).toBe(1);
		const [parked] = await outbox();
		expect(parked).toMatchObject({
			envelope: { id: 's1' },
			parked: {
				reason: 'refused',
				errors: { 'payload.reps': 'Must be 50 or fewer' },
				message: 'A value is not valid'
			}
		});

		const fix = edit('s1', 4);
		await saved(store, fix);
		await saved(store, log('s3', 3));
		await sync.flush();
		expect(server.received.at(-1)!.ids).toEqual(['s3']);
		expect(server.rows('s3')).toBe(1);

		clock.advance(10 * MINUTE);
		await sync.flush();
		expect(server.arrivals(fix.id)).toBe(0);
		expect(await outboxIds()).toEqual(['s1', fix.id]);
		expect(sync.status()).toEqual({ state: 'attention', count: 1 });
	});

	it('keeps deferred changes queued and parks one deferred for 24 hours as needs attention', async () => {
		const store = await open();
		await saved(store, start(), attach());
		const ghost = edit('ghost', 4); // a set this device never logged: the server waits for it
		await saved(store, ghost);
		const first = engine(store);
		await first.flush();

		let [entry] = await outbox();
		expect(entry).toMatchObject({ envelope: { id: ghost.id }, attempts: 1, failingSince: T0 });
		expect(entry!.parked).toBeUndefined();
		const wait = nextDelay(0, () => 0.5); // the store's backoff for the entry
		expect(entry!.nextAt).toBe(T0 + wait);

		clock.advance(wait - 1);
		await settle();
		expect(server.arrivals(ghost.id)).toBe(1);
		clock.advance(1); // a timer for the entry's own wait
		await eventually(() => expect(server.arrivals(ghost.id)).toBe(2));
		await first.flush();
		[entry] = await outbox();
		expect(entry).toMatchObject({ attempts: 2 });
		expect(entry!.nextAt).toBeGreaterThan(clock.now());

		// 'online' ends every wait at once.
		page.window.dispatchEvent(new Event('online'));
		await first.flush();
		expect(server.arrivals(ghost.id)).toBe(3);
		first.stop();

		// The next day the app starts again, and the change is still waiting.
		clock.jump(24 * HOUR);
		const next = engine(store);
		await next.flush();
		expect(server.arrivals(ghost.id)).toBe(4);
		[entry] = await outbox();
		expect(entry!.parked).toEqual({
			reason: 'stuck',
			errors: {},
			message: 'Waiting for an earlier change'
		});
		expect(next.status()).toEqual({ state: 'attention', count: 1 });
	});

	it('parks a change too large to send even alone, and still sends the rest', async () => {
		const store = await open();
		await withSets(store);
		const huge = notes('x'.repeat(SYNC_LIMITS.maxBytes));
		await saved(store, huge);
		await saved(store, log('s1'));
		await engine(store).flush();

		expect(server.arrivals(huge.id)).toBe(0);
		expect(server.rows('s1')).toBe(1);
		const [entry] = await outbox();
		expect(entry).toMatchObject({
			envelope: { id: huge.id },
			parked: { reason: 'refused', message: 'A value is not valid' }
		});
	});
});

// ---- When it sends ---------------------------------------------------------------------------

describe('triggers', () => {
	it('sends nothing offline, counts nothing, time included, and reads offline · N pending', async () => {
		const store = await open();
		await withSets(store, 's1');
		server.script.push(500, 500);
		const before = engine(store);
		await before.flush(); // one failure, before the device went offline
		before.stop();

		online = false;
		const sync = engine(store); // the app starts again, offline
		await sync.flush();
		expect(server.received).toHaveLength(1);
		expect((await outbox()).map((e) => [e.attempts, e.failingSince, e.nextAt])).toEqual([
			[1, T0, null],
			[0, null, null]
		]);
		expect(sync.status()).toEqual({ state: 'offline', pending: 2 });
		expect(clock.pending).toBe(0);

		// Two hours offline count nothing towards the 24 hours before 'Needs attention'.
		clock.jump(2 * HOUR);
		online = true;
		page.window.dispatchEvent(new Event('online'));
		await sync.flush();
		expect(server.received).toHaveLength(2);
		expect((await outbox())[0]).toMatchObject({ attempts: 2, failingSince: T0 + 2 * HOUR });
	});

	it("flushes at once on 'online' and on becoming visible, even mid-backoff", async () => {
		const store = await open();
		await withSets(store, 's1');
		server.script.push(500, 500);
		const sync = engine(store, { random: () => 0.99 });
		await sync.flush();
		expect(server.received).toHaveLength(1);
		expect(sync.status()).toMatchObject({ state: 'retrying' });

		online = false;
		page.window.dispatchEvent(new Event('offline'));
		expect(sync.status()).toEqual({ state: 'offline', pending: 2 });
		online = true;
		page.window.dispatchEvent(new Event('online'));
		await sync.flush();
		expect(server.received).toHaveLength(2);

		page.document.visibilityState = 'hidden';
		page.document.dispatchEvent(new Event('visibilitychange'));
		await sync.flush();
		expect(server.received).toHaveLength(2);
		page.document.visibilityState = 'visible';
		page.document.dispatchEvent(new Event('visibilitychange'));
		await sync.flush();
		expect(server.received).toHaveLength(3);
		expect(await outbox()).toEqual([]);
	});

	it('never lets two engines on one lock have two requests in flight', async () => {
		const tabA = await open();
		await withSets(tabA, 'a0');
		const tabB = await open();
		await tabB.getActive();
		server.latency = 5;
		const counted = (tab: string) => (url: string, init: RequestInit) => {
			sent[tab] = (sent[tab] ?? 0) + 1;
			return server.fetch(url, init);
		};
		const sent: Record<string, number> = {};
		const a = engine(tabA, { fetch: counted('a') });
		const b = engine(tabB, { fetch: counted('b') });
		for (let i = 1; i <= 4; i++) {
			await saved(tabA, log(`a${i}`, i + 1));
			await saved(tabB, log(`b${i}`, i + 5));
			// Each tab asks first in turn, so each holds the lock for some of the rounds.
			const [first, second] = i % 2 === 1 ? [a, b] : [b, a];
			await Promise.all([first.flush(), second.flush(), first.flush(), second.flush()]);
		}

		expect(server.maxInFlight).toBe(1);
		expect(sent.a).toBeGreaterThan(0);
		expect(sent.b).toBeGreaterThan(0);
		for (const id of ['a0', 'a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4']) {
			expect(server.rows(id)).toBe(1);
		}
		expect(await outbox()).toEqual([]);
	});

	it('lets every tab send without the lock API, and the server still holds one row', async () => {
		const tabA = await open();
		await withSets(tabA, 's1');
		const tabB = await open();
		server.latency = 20;
		const a = engine(tabA, { locks: null });
		const b = engine(tabB, { locks: null });
		await Promise.all([a.flush(), b.flush()]);

		expect(locks.names).toEqual([]);
		expect(server.maxInFlight).toBe(2);
		expect(server.arrivals('s1')).toBe(2);
		expect(server.rows('s1')).toBe(1);
		expect(await outbox()).toEqual([]);
	});

	it('does not count a request cancelled because the page is being left', async () => {
		const store = await open();
		await withSets(store, 's1');
		server.script.push('cancelled');
		let left = false;
		const leave = (url: string, init: RequestInit) => ((left = true), server.fetch(url, init));
		const sync = engine(store, { fetch: leave, leaving: () => left });
		await sync.flush();

		expect(server.received).toHaveLength(1);
		expect((await outbox()).map((e) => e.attempts)).toEqual([0, 0]);
		expect(clock.pending).toBe(0);
		expect(sync.status()).toEqual({ state: 'saving', pending: 2 });
	});

	it('never waits longer than 60 s between attempts', async () => {
		const store = await open();
		await withSets(store, 's1');
		server.script.push(...Array<Step>(12).fill(503));
		const sync = engine(store, { random: () => 0.999_999 });
		await sync.flush();
		for (let i = 0; i < 12; i++) {
			clock.advance(BACKOFF.maxMs);
			await sync.flush();
		}

		expect(server.received).toHaveLength(13);
		expect(Math.max(...clock.delays)).toBeLessThanOrEqual(BACKOFF.maxMs);
		expect(clock.delays.filter((d) => d > 59 * SECOND).length).toBeGreaterThan(3);
		expect(await outbox()).toEqual([]);
	});
});

// ---- Lie-fi: online, but the server out of reach ---------------------------------------------

describe('lie-fi: online, but the server out of reach', () => {
	it("counts no timeout, network error or page that is not the server's JSON, backs off, and reads Can’t connect · N waiting", async () => {
		const store = await open();
		await withSets(store, 's1');
		server.script.push('hang', 'cancelled', 'portal', 'gateway', 'hang');
		const countFailure = vi.spyOn(store, 'countFailure');
		const sync = engine(store);
		await eventually(() => expect(server.received).toHaveLength(1));
		expect(sync.status()).toEqual({ state: 'saving', pending: 2 });

		clock.advance(REQUEST_TIMEOUT_MS);
		await eventually(() => expect(sync.status()).toEqual({ state: 'unreachable', waiting: 2 }));
		await sync.flush(); // a dispatch's flush waits for the backoff
		await settle();
		expect(server.received).toHaveLength(1);

		for (const sent of [2, 3, 4]) {
			clock.advance(BACKOFF.maxMs); // the engine's own timer sends again
			await eventually(() => expect(server.received).toHaveLength(sent));
			await sync.flush();
			expect(sync.status()).toEqual({ state: 'unreachable', waiting: 2 });
		}
		clock.advance(BACKOFF.maxMs);
		await eventually(() => expect(server.received).toHaveLength(5));
		// A retry on its way still reads Can’t connect, not Saving…, until the server answers.
		expect(sync.status()).toEqual({ state: 'unreachable', waiting: 2 });
		clock.advance(REQUEST_TIMEOUT_MS);
		await sync.flush();
		expect(countFailure).not.toHaveBeenCalled();
		expect((await outbox()).map((e) => [e.attempts, e.failingSince])).toEqual([
			[0, null],
			[0, null]
		]);

		clock.advance(BACKOFF.maxMs); // the server answers at last
		await eventually(async () => expect(await outbox()).toEqual([]));
		await sync.flush();
		expect(server.rows('s1')).toBe(1);
		expect(sync.status()).toEqual({ state: 'synced' });
	});

	it('never parks the workout behind Needs attention, however long the lie-fi lasts', async () => {
		const store = await open();
		await withSets(store, 's1');
		const STEPS: Step[] = ['portal', 'gateway', 'cancelled'];
		const misses = STUCK_AFTER.failures + 10;
		server.script.push(...Array.from({ length: misses }, (_, i) => STEPS[i % STEPS.length]!));
		const sync = engine(store);
		await sync.flush();
		for (let sent = 2; sent <= misses; sent++) {
			clock.advance(BACKOFF.maxMs);
			await eventually(() => expect(server.received).toHaveLength(sent));
			await sync.flush();
		}

		const outboxNow = await outbox();
		expect(outboxNow.map((e) => [e.attempts, e.failingSince, e.parked])).toEqual([
			[0, null, undefined],
			[0, null, undefined]
		]);
		expect(sync.status()).toEqual({ state: 'unreachable', waiting: 2 });

		clock.advance(BACKOFF.maxMs);
		await eventually(async () => expect(await outbox()).toEqual([]));
		expect(server.rows(W)).toBe(1);
		expect(server.rows('s1')).toBe(1);
	});

	it('pauses the 24 hours while the server is out of reach, as it does offline', async () => {
		const store = await open();
		await withSets(store, 's1');
		server.script.push(500, 'portal', 500);
		const sync = engine(store);
		await sync.flush(); // the server's own 500: counted
		expect((await outbox())[0]).toMatchObject({ attempts: 1, failingSince: T0 });

		const wait = nextDelay(0, seeded(SEED));
		clock.advance(wait); // the backoff timer: the gym's Wi-Fi answers with its sign-in page
		await eventually(() => expect(server.received).toHaveLength(2));
		await sync.flush();
		expect(sync.status()).toEqual({ state: 'unreachable', waiting: 2 });

		// A day and an hour later the app is in view again, and the server answers 500 once more.
		clock.jump(25 * HOUR);
		page.document.dispatchEvent(new Event('visibilitychange'));
		await eventually(() => expect(server.received).toHaveLength(3));
		await sync.flush();
		const [head] = await outbox();
		expect(head).toMatchObject({ attempts: 2, failingSince: T0 + 25 * HOUR });
		expect(head!.parked).toBeUndefined();
		expect(sync.status()).toMatchObject({ state: 'retrying', pending: 2 });
	});

	it('pauses out of reach, then offline, as one stretch, taken off the 24 hours once', async () => {
		const store = await open();
		await withSets(store, 's1');
		server.script.push(500, 'portal', 500);
		const sync = engine(store);
		await sync.flush(); // the server's own 500: counted
		const wait = nextDelay(0, seeded(SEED));
		clock.advance(wait); // the gym's Wi-Fi answers with its sign-in page
		await eventually(() => expect(server.received).toHaveLength(2));
		await sync.flush();
		expect(sync.status()).toEqual({ state: 'unreachable', waiting: 2 });

		// An hour later the phone gives up on the Wi-Fi, and is offline for two more.
		clock.jump(HOUR);
		online = false;
		await sync.flush();
		expect(sync.status()).toEqual({ state: 'offline', pending: 2 });
		clock.jump(2 * HOUR);
		online = true;
		page.window.dispatchEvent(new Event('online'));
		await eventually(() => expect(server.received).toHaveLength(3));
		await sync.flush();
		const [head] = await outbox();
		expect(head).toMatchObject({ attempts: 2, failingSince: T0 + 3 * HOUR });
		expect(sync.status()).toMatchObject({ state: 'retrying', pending: 2 });
	});
});

// ---- The session ---------------------------------------------------------------------------

describe('a lost session', () => {
	it('401: deletes what the server holds, keeps unsynced changes and the unfinished workout’s device state, and stops', async () => {
		const store = await open();
		await store.saveKit(KIT.plannedLineage!, KIT);
		const db = await openDB(DB_NAME);
		await db.put(STORES.library, { id: 'exercises', digest: 'd1', exercises: [], savedAt: T0 });
		await db.put(STORES.meta, { key: 'units', value: { weight: 'kg', distance: 'km' } });
		db.close();
		// A finished workout, synced; then an unfinished one, its start synced.
		await withSets(store, 's1');
		await saved(store, finish());
		const sync = engine(store);
		await sync.flush();
		await saved(store, start(W2), attach(W2));
		await sync.flush();
		expect(await outbox()).toEqual([]);
		await saved(store, log('s3', 1, W2), { type: 'goTo', workoutId: W2, position: 2 });
		await saved(store, log('s4', 2, W2), {
			type: 'draft',
			workoutId: W2,
			position: 2,
			setIndex: 1,
			draft: { weight: 60 }
		});
		await saved(store, {
			type: 'kit.attach',
			workoutId: W2,
			exerciseId: 'leg_press',
			previous: { date: '2026-10-30', sets: [done] }
		});

		server.script.push(401);
		await sync.flush();

		const after = await openDB(DB_NAME);
		const workouts = (await after.getAll(STORES.workouts)) as StoredWorkout[];
		expect(await after.getAll(STORES.kits)).toEqual([]);
		expect(await after.getAll(STORES.library)).toEqual([]);
		expect(await after.getAll(STORES.meta)).toEqual([{ key: 'signedOut', value: true }]);
		after.close();
		expect(workouts.map((w) => w.id)).toEqual([W2]);
		const [kept] = workouts;
		expect(kept).toMatchObject({ kit: null, canonical: null, title: '', status: 'in_progress' });
		expect(kept!.device).toMatchObject({ position: 2, drafts: { '2:1': { weight: 60 } } });
		expect(kept!.device.attached).toEqual({});
		expect(await outboxIds()).toEqual(['s3', 's4']);
		expect(store.snapshot(W)).toBeNull();
		expect(store.snapshot(W2)!.view).toBeNull(); // no workout details left to show
		expect(sync.status()).toEqual({ state: 'signed-out', waiting: 2 });

		// Nothing else is sent until a sign-in: no busy loop, whatever happens.
		const requests = server.received.length;
		page.window.dispatchEvent(new Event('online'));
		page.document.dispatchEvent(new Event('visibilitychange'));
		page.window.dispatchEvent(new Event('pagehide'));
		await sync.flush();
		clock.advance(HOUR);
		await settle();
		expect(server.received).toHaveLength(requests);
		expect(clock.pending).toBe(0);
		expect(await outboxIds()).toEqual(['s3', 's4']);

		// A later page still shows it signed out, offline too, until the server answers as the owner.
		sync.stop();
		online = false;
		const later = engine(store);
		await later.flush();
		expect(later.status()).toEqual({ state: 'signed-out', waiting: 2 });
		online = true;
		page.window.dispatchEvent(new Event('online'));
		await eventually(() => expect(later.status()?.state).not.toBe('signed-out'));
		expect(await store.signedOut()).toBe(false);
	});

	it('403 passkey_required keeps everything and stops', async () => {
		const store = await open();
		await store.saveKit(KIT.plannedLineage!, KIT);
		await withSets(store, 's1');
		server.script.push('passkey');
		const sync = engine(store);
		await sync.flush();

		expect(sync.status()).toEqual({ state: 'passkey', waiting: 2 });
		expect(await outboxIds()).toEqual([W, 's1']);
		expect((await outbox()).map((e) => e.attempts)).toEqual([0, 0]);
		expect(await store.getKit(KIT.plannedLineage!)).toStrictEqual(KIT);
		expect(store.snapshot(W)!.view!.kit).toStrictEqual(KIT);

		page.window.dispatchEvent(new Event('online'));
		await sync.flush();
		clock.advance(HOUR);
		await settle();
		expect(server.received).toHaveLength(1);
		expect(clock.pending).toBe(0);
	});

	it('backs off on any other 403, as on a 5xx', async () => {
		const store = await open();
		await withSets(store, 's1');
		server.script.push('forbidden');
		const sync = engine(store);
		await sync.flush();

		expect((await outbox())[0]).toMatchObject({ attempts: 1, failingSince: T0 });
		expect(sync.status()).toMatchObject({ state: 'retrying', pending: 2 });
		clock.advance(nextDelay(0, seeded(SEED)));
		await sync.flush();
		expect(server.received).toHaveLength(2);
		expect(await outbox()).toEqual([]);
	});
});

// ---- Leaving the page ------------------------------------------------------------------------

describe('pagehide', () => {
	it('sends the head of the outbox with keepalive within 48 KB, leaving RUM’s beacon room in 64 KB', async () => {
		const store = await open();
		await withSets(store);
		const long = Array.from({ length: 25 }, (_, i) => notes(`${i} ${'x'.repeat(3000)}`));
		for (const m of long) await saved(store, m);
		server.script.push(503);
		const sync = engine(store);
		await sync.flush(); // the server is down: everything is still queued

		// RUM, started on the same page, with as many metrics queued as it holds before a flush.
		const beacons: number[] = [];
		vi.stubGlobal('window', page.window);
		vi.stubGlobal('addEventListener', page.window.addEventListener.bind(page.window));
		vi.stubGlobal('document', Object.assign(page.document, { documentElement: { dataset: {} } }));
		vi.stubGlobal('navigator', {
			sendBeacon: (_url: string, blob: Blob) => (beacons.push(blob.size), true)
		});
		const { startVitalsReporting } = await import('../vitals');
		const { noteNavigation } = await import('../visits');
		noteNavigation('/workout', '/workout', 0);
		await startVitalsReporting();
		for (let i = 0; i < 19; i++) {
			vitals.report[1]!({
				id: `v5-1730916000000-${1000000000000 + i}`,
				name: 'INP',
				value: 123.4567,
				delta: 12.3456,
				rating: 'needs-improvement',
				navigationType: 'back-forward-cache',
				navigationId: 1,
				entries: [{ startTime: 1000 + i }]
			} satisfies Omit<Metric, 'entries'> & { entries: unknown[] });
		}

		// Leaving the page: `pagehide`, then `visibilitychange`, which bubbles to the window.
		page.window.dispatchEvent(new Event('pagehide'));
		page.document.visibilityState = 'hidden';
		for (const target of [page.document, page.window])
			target.dispatchEvent(new Event('visibilitychange'));

		const keepalive = server.received.filter((r) => r.keepalive);
		expect(keepalive).toHaveLength(1);
		const queued = await outboxIds();
		expect(keepalive[0]!.ids).toEqual(queued.slice(0, keepalive[0]!.ids.length));
		expect(keepalive[0]!.bytes).toBeLessThanOrEqual(SYNC_LIMITS.keepaliveBytes);
		expect(keepalive[0]!.bytes).toBeGreaterThan(SYNC_LIMITS.keepaliveBytes - 4 * KB);
		expect(beacons).toHaveLength(1);
		expect(keepalive[0]!.bytes + beacons[0]!).toBeLessThanOrEqual(64 * KB);
	});
});

describe('a discard while a request may still be running on the server (finding F1)', () => {
	it('sends the discarded id first, so the late request never lands it after the newer edit', async () => {
		const store = await open();
		await withSets(store, 's1');
		const e = engine(store);
		await eventually(async () => expect(await outboxIds()).toEqual([]));

		// The edit's POST passes 15 s while the server is still running it.
		server.script.push('late');
		const stale = edit('s1', 6);
		await saved(store, stale);
		void e.flush();
		await eventually(() => expect(server.received.at(-1)!.ids).toEqual([stale.id]));
		clock.advance(REQUEST_TIMEOUT_MS);
		await eventually(() => expect(e.status()).toMatchObject({ state: 'unreachable' }));

		// The owner discards it and edits the set again.
		await store.discard((await outbox())[0]!.seq);
		const newer = edit('s1', 4);
		await saved(store, newer);
		clock.advance(BACKOFF.maxMs);
		await e.flush();
		await eventually(async () => expect(await outboxIds()).toEqual([]));

		// The server reaches the stale request last: the discarded edit is a duplicate, not applied.
		expect(server.landLate()).toMatchObject([[{ id: stale.id, status: 'duplicate' }]]);
		expect(server.rowsOf(W)!.sets.find((s) => s.id === 's1')!.reps).toBe(4);
		expect(server.received.at(-1)).toMatchObject({ ids: [newer.id], discarded: [stale.id] });
		expect(await store.discarded()).toEqual([]);
	});

	it('claims every discarded id before a newer change, more than one request holds too', async () => {
		const store = await open();
		await withSets(store, 's1');
		const stale = edit('s1', 6);
		const newer = edit('s1', 4);
		const late: SyncResult[][] = [];
		const e = engine(store, {
			async fetch(url, init) {
				const answer = await server.fetch(url, init);
				// The server reaches the stale request right after the first one carrying the newer edit.
				if ((init.body as string).includes(newer.id)) late.push(...server.landLate());
				return answer;
			}
		});
		await eventually(async () => expect(await outboxIds()).toEqual([]));
		server.script.push('late');
		await saved(store, stale);
		void e.flush();
		await eventually(() => expect(server.received.at(-1)!.ids).toEqual([stale.id]));
		clock.advance(REQUEST_TIMEOUT_MS);
		await eventually(() => expect(e.status()).toMatchObject({ state: 'unreachable' }));

		// As many older discards as one request holds still wait, so the stale edit's id is the 26th.
		const older = Array.from({ length: SYNC_LIMITS.maxMutations }, fresh);
		const db = await openDB(DB_NAME);
		await db.put(STORES.meta, { key: 'discarded', value: older });
		db.close();
		await store.discard((await outbox())[0]!.seq);
		await saved(store, newer);
		clock.advance(BACKOFF.maxMs);
		await e.flush();
		await eventually(async () => expect(await outboxIds()).toEqual([]));

		expect(late).toMatchObject([[{ id: stale.id, status: 'duplicate' }]]);
		expect(server.rowsOf(W)!.sets.find((s) => s.id === 's1')!.reps).toBe(4);
		expect(server.received.slice(-2).map((r) => [r.ids, r.discarded.length])).toEqual([
			[[], SYNC_LIMITS.maxMutations],
			[[newer.id], 1]
		]);
	});

	it('sends a discard alone when nothing else is waiting, and on pagehide', async () => {
		const store = await open();
		await withSets(store, 's1');
		const e = engine(store);
		await eventually(async () => expect(await outboxIds()).toEqual([]));
		await saved(store, edit('s1', 6));
		server.script.push(500);
		await e.flush();
		const [entry] = await outbox();

		await store.discard(entry!.seq);
		await e.flush(); // the store's change flushes; mid-backoff it only reads the outbox
		page.window.dispatchEvent(new Event('pagehide'));
		clock.advance(BACKOFF.maxMs);

		await eventually(() => expect(server.received).toHaveLength(4));
		const last = server.received.slice(-2);
		expect(last.map((r) => [r.ids, r.discarded, r.keepalive])).toEqual([
			[[], [entry!.envelope.id], true],
			[[], [entry!.envelope.id], false]
		]);
		await eventually(async () => expect(await store.discarded()).toEqual([]));
	});
});
