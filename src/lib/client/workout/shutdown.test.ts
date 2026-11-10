import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { deleteDB, openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import { createMutation } from '#lib/domain/workout/index.ts';
import type { SyncRequest, SyncResponse } from '#lib/domain/workout/index.ts';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import { DB_NAME, STORES } from './names';
import { pendingCount } from './probe';
import { FLUSH_LIMIT_MS, keepOnlyUnsynced, unsyncedAfterFlush } from './shutdown';
import { createStore } from './store';

const KIT = workoutDayKits({ date: '2026-11-06' }).strength;
const W = '00000000-0000-4000-8000-0000000000d1';
let ids = 0;
const fresh = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;

/** A started workout with a skipped set: two changes waiting, and a saved kit. */
async function seed() {
	const store = await createStore({ table: strengthTable, channel: null });
	const start = createMutation(
		'workout.start',
		{
			workoutId: W,
			at: '2026-11-06T18:00:00.000Z',
			payload: {
				kind: 'strength',
				title: KIT.title,
				sessionType: KIT.sessionType,
				discipline: KIT.discipline,
				plannedSessionId: null,
				plannedLineage: null,
				programId: null
			}
		},
		fresh
	);
	const skip = createMutation(
		'set.skip',
		{
			workoutId: W,
			at: '2026-11-06T18:05:00.000Z',
			payload: {
				position: 1,
				plannedLineage: KIT.exercises[0]!.plannedLineage,
				setIndex: 1,
				exerciseId: KIT.exercises[0]!.exercise.id,
				unit: 'kg'
			}
		},
		fresh
	);
	expect(await store.dispatch(start, { type: 'kit.attach', workoutId: W, kit: KIT }).saved).toBe(
		'saved'
	);
	expect(await store.dispatch(skip).saved).toBe('saved');
	await store.saveKit('lineage-1', KIT);
	expect(await pendingCount()).toBe(2);
	return store;
}

/** A manual clock for the engine's timers and the limit's. */
function manualClock() {
	let now = 0;
	const timers = new Map<number, { at: number; run: () => void }>();
	let next = 0;
	return {
		setTimeout: (run: () => void, ms: number) => {
			timers.set(++next, { at: now + ms, run });
			return next;
		},
		clearTimeout: (timer: unknown) => void timers.delete(timer as number),
		now: () => now,
		advance(ms: number) {
			now += ms;
			for (const [id, { at, run }] of [...timers]) {
				if (at > now) continue;
				timers.delete(id);
				run();
			}
		}
	};
}

/** A sync endpoint that applies everything it is sent. */
const applies = vi.fn(async (_url: string, init: RequestInit) => {
	const { mutations } = JSON.parse(init.body as string) as SyncRequest;
	const body: SyncResponse = {
		v: 1,
		results: mutations.map(({ id }) => ({ id, status: 'applied' }))
	};
	return Response.json(body);
});

const engine = { locks: null, online: () => true, leaving: () => false } as const;

/** Lets every microtask and IndexedDB callback queued so far run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
	vi.stubGlobal('indexedDB', new IDBFactory());
});

afterEach(() => {
	vi.unstubAllGlobals();
	applies.mockClear();
});

describe('unsyncedAfterFlush', () => {
	it('reports 0 without creating pc-offline when nothing is pending', async () => {
		expect(await unsyncedAfterFlush({ ...engine, fetch: applies })).toBe(0);
		expect(await indexedDB.databases()).toEqual([]);
		expect(applies).not.toHaveBeenCalled();
	});

	it('flushes and reports what is left', async () => {
		await seed();
		expect(await unsyncedAfterFlush({ ...engine, fetch: applies })).toBe(0);
		expect(applies).toHaveBeenCalled();
		expect(await pendingCount()).toBe(0);
	});

	it('gives up after the limit and reports what is left', async () => {
		await seed();
		const clock = manualClock();
		const silent = vi.fn(() => new Promise<Response>(() => {}));
		const left = unsyncedAfterFlush({ ...engine, ...clock, fetch: silent });
		await vi.waitFor(() => expect(silent).toHaveBeenCalled());

		clock.advance(FLUSH_LIMIT_MS);

		expect(await left).toBe(2);
	});

	it('an answer after the database is deleted rejects nothing', async () => {
		await seed();
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on('unhandledRejection', onRejection);
		try {
			const clock = manualClock();
			let answer = (_: Response) => {};
			const late = vi.fn(async (url: string, init: RequestInit) => {
				const response = await applies(url, init);
				return new Promise<Response>((resolve) => (answer = () => resolve(response)));
			});
			const left = unsyncedAfterFlush({ ...engine, ...clock, fetch: late });
			await vi.waitFor(() => expect(late).toHaveBeenCalled());
			clock.advance(FLUSH_LIMIT_MS);
			expect(await left).toBe(2);

			let blocked = false;
			await deleteDB(DB_NAME, { blocked: () => (blocked = true) });
			answer(new Response());
			await settle();

			expect(blocked).toBe(false);
			expect(await indexedDB.databases()).toEqual([]);
			expect(rejections).toEqual([]);
		} finally {
			process.off('unhandledRejection', onRejection);
		}
	});
});

describe("the signing-out page after 'Stay signed in'", () => {
	it('opens the store again, and a second sign-out flushes again', async () => {
		await seed();
		const clock = manualClock();
		const silent = vi.fn(() => new Promise<Response>(() => {}));
		const left = unsyncedAfterFlush({ ...engine, ...clock, fetch: silent });
		await vi.waitFor(() => expect(silent).toHaveBeenCalled());
		clock.advance(FLUSH_LIMIT_MS);
		expect(await left).toBe(2);

		// The owner stays signed in and goes to /workout in this tab.
		const store = await createStore({ table: strengthTable, channel: null });
		expect((await store.getActive())!.workoutId).toBe(W);
		store.close();

		expect(await unsyncedAfterFlush({ ...engine, fetch: applies })).toBe(0);
		expect(applies).toHaveBeenCalled();
		expect(await pendingCount()).toBe(0);
	});

	it('opens the store again after keepOnlyUnsynced', async () => {
		await seed();
		await keepOnlyUnsynced();

		const store = await createStore({ table: strengthTable, channel: null });
		expect((await store.getActive())!.workoutId).toBe(W);
		store.close();
	});
});

describe('keepOnlyUnsynced', () => {
	it('keepOnlyUnsynced drops server copies and keeps the outbox', async () => {
		await seed();

		await keepOnlyUnsynced();

		const db = await openDB(DB_NAME);
		try {
			expect(await db.getAll(STORES.kits)).toEqual([]);
			expect(await db.count(STORES.outbox)).toBe(2);
			expect(await db.get(STORES.meta, 'signedOut')).toEqual({ key: 'signedOut', value: true });
		} finally {
			db.close();
		}
		// It let go of the database: deleting it is never blocked.
		let blocked = false;
		await deleteDB(DB_NAME, { blocked: () => (blocked = true) });
		expect(blocked).toBe(false);
	});
});
