import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { SyncResponse } from '../src/lib/domain/workout';
import { adHoc, finishedWorkout } from '../scripts/lib/workout-seed';
import type { WorkoutDayKits } from '../tests/fixtures/workout-day';
import { expectLoadBudget, GUARD_MS } from './load-budget';
import { resetPrograms } from './program-support';
import { SAME_ORIGIN } from './support';
import { seedWorkout, workoutDay } from './workout-support';

/**
 * The main-thread budget while the workout screens load (e2e/load-budget.ts: median blocking time
 * of 5 cold loads at 4× CPU, within GUARD_MS), measured as they are used (M4): the three workout
 * routes with a workout in progress on the device (the shared kit fixture, seeded into each fresh
 * context's IndexedDB before the load; sync runs against the real endpoint), and workout History's
 * list and detail with a full first page of finished workouts, synced through the real API as a
 * device sends them. perf.e2e.ts measures the app's other screens the same way.
 */
/** Each workout route with the fixture's workout of its kind in progress, and what it then shows. */
const ACTIVE_WORKOUTS: Record<string, { kind: keyof WorkoutDayKits; shows: string }> = {
	'/workout (active)': { kind: 'strength', shows: 'set-logger' },
	'/workout/run (active)': { kind: 'run', shows: 'run-entry' },
	'/workout/session (active)': { kind: 'other', shows: 'session-entry' }
};
/** Workout History with a full first page (20) of finished workouts, and the newest one's detail. */
const WORKOUT_HISTORY = '/progress/workouts';
const WORKOUT_DETAIL = '/progress/workouts/<newest>';
const HISTORY_WORKOUTS = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

/** HISTORY_WORKOUTS finished workouts, one a day back from yesterday: the newest one's id. */
async function seedHistory(request: APIRequestContext): Promise<string> {
	const { strength } = await workoutDay();
	let newest = '';
	for (let day = 1; day <= HISTORY_WORKOUTS; day++) {
		const { workoutId, mutations } = finishedWorkout(strength, Date.now() - day * DAY_MS);
		for (let i = 0; i < mutations.length; i += 20) {
			const batch = mutations.slice(i, i + 20);
			const response = await request.post('/api/workouts/sync', {
				headers: SAME_ORIGIN,
				data: { v: 1, mutations: batch }
			});
			expect(response.status()).toBe(200);
			const { results } = (await response.json()) as SyncResponse;
			expect(results.map((r) => r.status)).toEqual(batch.map(() => 'applied'));
		}
		newest ||= workoutId;
	}
	return newest;
}

test.describe('main-thread budget (4× CPU)', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'CPU throttling uses CDP');
	test.afterAll(() => resetPrograms());

	for (const [path, { kind, shows }] of Object.entries(ACTIVE_WORKOUTS)) {
		test(`${path} blocks the main thread ≤ ${GUARD_MS} ms while loading`, async ({
			browser
		}, testInfo) => {
			// Ad hoc, so each start syncs (the fixture's planned session is not in this database).
			const kit = adHoc((await workoutDay())[kind]);
			// Every load's device holds its own workout; each one's start syncs, so clear them after.
			const prepare = async (page: Page) => {
				await seedWorkout(page, kit);
			};
			const url = path.replace(' (active)', '');
			await expectLoadBudget(
				path,
				{ url, restore: resetPrograms, prepare, shows },
				{ browser, testInfo }
			);
		});
	}

	for (const path of [WORKOUT_HISTORY, WORKOUT_DETAIL]) {
		test(`${path} blocks the main thread ≤ ${GUARD_MS} ms while loading`, async ({
			browser,
			request
		}, testInfo) => {
			await resetPrograms();
			const newest = await seedHistory(request);
			const detail = path === WORKOUT_DETAIL;
			await expectLoadBudget(
				path,
				{
					url: detail ? `${WORKOUT_HISTORY}/${newest}` : path,
					restore: resetPrograms,
					shows: detail ? 'workout-detail' : 'workout-row'
				},
				{ browser, testInfo }
			);
		});
	}
});
