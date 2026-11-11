import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import { createMutation } from '#lib/domain/workout/index.ts';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import { ActiveWorkout } from './active.svelte.ts';
import type { ChunkLoad } from './active.svelte.ts';
import { broadcast, openTabChannel } from './channel';
import { goOnline } from './online';
import { createStore } from './store';
import type { StoreOptions } from './store';

const KIT = workoutDayKits({ date: '2026-11-06' }).strength;
const W = '00000000-0000-4000-8000-0000000000a1';
let ids = 0;
const fresh = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;
/** Two tabs in one process: each store gets its own end of a test channel. */
const CHANNEL = 'pc-workout-active-test';
const tab = (options: StoreOptions) =>
	createStore({ ...options, channel: openTabChannel(CHANNEL) });
/**
 * What this page's engine sends: the ids of each batch. Left unanswered (and never timed out)
 * unless `applying`: then each is applied, with no rows, so the workout leaves this device's view.
 */
const sent: string[][] = [];
let applying = false;
const fetch = (_url: string, init: RequestInit) => {
	const { mutations } = JSON.parse(init.body as string) as { mutations: { id: string }[] };
	sent.push(mutations.map((m) => m.id));
	const results = mutations.map(({ id }) => ({ id, status: 'applied' }));
	return applying
		? Promise.resolve(Response.json({ v: 1, results }))
		: new Promise<Response>(() => {});
};
const load = (async () => ({
	goOnline: (options: StoreOptions) =>
		goOnline(
			{ ...options, channel: openTabChannel(CHANNEL) },
			{
				fetch,
				locks: null,
				events: null,
				online: () => true,
				leaving: () => false,
				setTimeout: () => 0,
				clearTimeout: () => {}
			}
		)
})) as unknown as ChunkLoad;

beforeEach(() => {
	vi.stubGlobal('indexedDB', new IDBFactory());
	sent.length = 0;
	applying = false;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('the active workout', () => {
	it('shows a workout another tab starts while this page shows none', async () => {
		const page = new ActiveWorkout(async () => strengthTable);
		await page.restore((code) => code());
		expect(page.current.phase).toBe('empty');
		await page.connect(load);
		expect(page.current.phase).toBe('empty');

		const other = await tab({ table: strengthTable });
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
		expect(await other.dispatch(start, { type: 'kit.attach', workoutId: W, kit: KIT }).saved).toBe(
			'saved'
		);

		await vi.waitFor(() => expect(page.current.phase).toBe('active'));
		expect(page.current.phase === 'active' && page.current.snapshot.workoutId).toBe(W);
		page.close();
		broadcast({ type: 'signed-out' }, CHANNEL); // both stores close their channel
	});

	describe("the page's one sync engine", () => {
		const startOf = (workoutId: string) =>
			createMutation(
				'workout.start',
				{
					workoutId,
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
		const kit = { type: 'kit.attach', workoutId: W, kit: KIT } as const;
		const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

		afterEach(() => broadcast({ type: 'signed-out' }, CHANNEL));

		it('starts with the store and flushes its changes, until the page closes', async () => {
			applying = true;
			const page = new ActiveWorkout(async () => strengthTable);
			await page.restore((code) => code());
			expect(await page.connect(load)).not.toBeNull();

			const other = await tab({ table: strengthTable });
			const start = startOf(W);
			expect(await other.dispatch(start, kit).saved).toBe('saved');
			await vi.waitFor(() => expect(sent.flat()).toEqual([start.id]));

			page.close();
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
			expect(await other.dispatch(skip).saved).toBe('saved');
			await settle();
			expect(sent.flat()).toEqual([start.id]);
		});

		it('shows a workout finished here as completed, restores it so, and keeps it once it syncs and leaves the device', async () => {
			const before = await createStore({ table: strengthTable, channel: null });
			expect(await before.dispatch(startOf(W), kit).saved).toBe('saved');
			const page = new ActiveWorkout(async () => strengthTable);
			await page.restore((code) => code());
			expect(page.current.phase).toBe('active');
			const store = (await page.connect(load))!;
			const finish = createMutation(
				'workout.finish',
				{ workoutId: W, at: '2026-11-06T19:00:00.000Z', payload: { sessionRpe: 8 } },
				fresh
			);
			expect(await store.dispatch(finish).saved).toBe('saved');
			expect(page.current.phase).toBe('completed');
			page.close();

			// Reloaded while it waits to sync (offline): the completed state again.
			const reload = new ActiveWorkout(async () => strengthTable);
			await reload.restore((code) => code());
			expect(reload.current.phase).toBe('completed');
			applying = true;
			const again = (await reload.connect(load))!;
			await vi.waitFor(async () => expect(await again.outbox()).toEqual([]));
			await vi.waitFor(async () => expect(await again.load(W)).toBeNull());
			expect(
				reload.current.phase === 'completed' && reload.current.snapshot.view.workout
			).toMatchObject({ id: W, status: 'completed', sessionRpe: 8 });
			reload.close();
		});

		describe('a write asked for before the store opens', () => {
			const at = Date.parse('2026-11-06T18:10:00.000Z');
			const restored = async () => {
				const before = await createStore({ table: strengthTable, channel: null });
				expect(await before.dispatch(startOf(W), kit).saved).toBe('saved');
				const page = new ActiveWorkout(async () => strengthTable);
				await page.restore((code) => code());
				expect(page.current.phase).toBe('active');
				return page;
			};
			const restOf = (page: ActiveWorkout) =>
				page.current.phase === 'active' ? page.current.snapshot.view.device.rest : undefined;

			it('waits for the store, then runs as it opens, in the order asked', async () => {
				const page = await restored();
				page.write((store) =>
					store.dispatch({ type: 'rest.start', workoutId: W, at, durationMs: 120_000 })
				);
				page.write((store) => store.dispatch({ type: 'rest.pause', workoutId: W, at: at + 5_000 }));
				expect(page.store).toBeNull();
				expect(restOf(page)).toBeNull();

				const store = (await page.connect(load))!;
				expect(restOf(page)).toMatchObject({ startedAt: at, pausedAt: at + 5_000 });
				// Kept on the device as a tap after the store opened would be.
				expect(store.snapshot(W)?.view?.device.rest).toMatchObject({ pausedAt: at + 5_000 });
				page.close();
			});

			it('takes the same tap once while it waits, and every tap once the store is open', async () => {
				const page = await restored();
				const complete = vi.fn();
				const skip = vi.fn();
				page.write(complete, 'set:1:1');
				page.write(complete, 'set:1:1');
				page.write(skip, 'set:1:2');
				page.write(skip);
				page.write(skip);

				const store = (await page.connect(load))!;
				expect(complete).toHaveBeenCalledExactlyOnceWith(store);
				expect(skip).toHaveBeenCalledTimes(3);
				page.write(complete, 'set:1:1');
				expect(complete).toHaveBeenCalledTimes(2);
				page.close();
			});

			it('runs none into a workout no longer in progress, nor after the page closed', async () => {
				const before = await createStore({ table: strengthTable, channel: null });
				const finish = createMutation(
					'workout.finish',
					{ workoutId: W, at: '2026-11-06T19:00:00.000Z', payload: { sessionRpe: 8 } },
					fresh
				);
				expect(await before.dispatch(startOf(W), kit, finish).saved).toBe('saved');
				const done = new ActiveWorkout(async () => strengthTable);
				await done.restore((code) => code());
				expect(done.current.phase).toBe('completed');
				const late = vi.fn();
				done.write(late);
				expect(await done.connect(load)).not.toBeNull();
				expect(late).not.toHaveBeenCalled();
				done.close();

				const closed = new ActiveWorkout(async () => strengthTable);
				await closed.restore((code) => code());
				closed.write(late);
				closed.close();
				expect(await closed.connect(load)).toBeNull();
				expect(late).not.toHaveBeenCalled();
			});
		});

		it('never starts flushing for a page closed while its store opens', async () => {
			const page = new ActiveWorkout(async () => strengthTable);
			await page.restore((code) => code());
			const connecting = page.connect(load);
			page.close();
			expect(await connecting).toBeNull();

			const other = await tab({ table: strengthTable });
			expect(await other.dispatch(startOf(W), kit).saved).toBe('saved');
			await settle();
			expect(sent).toEqual([]);
		});
	});
});
