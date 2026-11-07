import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import { createMutation } from '#lib/domain/workout/index.ts';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import { ActiveWorkout } from './active.svelte.ts';
import type { ChunkLoad } from './active.svelte.ts';
import { broadcast, openTabChannel } from './channel';
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
const load = (async () => ({ createStore: tab })) as unknown as ChunkLoad;

beforeEach(() => {
	vi.stubGlobal('indexedDB', new IDBFactory());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('the active workout', () => {
	it('shows a workout another tab starts while this page shows none', async () => {
		const page = new ActiveWorkout(strengthTable);
		await page.restore();
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
});
