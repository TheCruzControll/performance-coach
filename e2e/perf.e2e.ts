import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { SyncResponse } from '../src/lib/domain/workout';
import { adHoc, finishedWorkout } from '../scripts/lib/workout-seed';
import { ANALYTICS_TZ, seedAnalytics, type SeededAnalytics } from './analytics-support';
import { COACH_TZ, postTurn, resetCoach, seedCoach } from './coach-support';
import { resetPrograms, seedProgram } from './program-support';
import { seedReview, type ReviewScenario, type SeededReview } from './review-support';
import { query, SAME_ORIGIN } from './support';
import type { WorkoutDayKits } from '../tests/fixtures/workout-day';
import { seedWorkout, workoutDay } from './workout-support';

/**
 * Main-thread budget while a screen loads and hydrates, measured from real long tasks
 * (PerformanceObserver) under DevTools 4× CPU throttling: the sum of each task's time over
 * 50 ms, i.e. total blocking time, over load + 1.5 s. Median of 5 cold loads per screen.
 *
 * This is the CI regression guard for hydration cost: it measures real work, while
 * Lighthouse's TBT is a simulation (×4 of observed task time) that amplifies VM noise
 * (docs/performance.md).
 *
 * Two numbers, deliberately separate:
 * - TARGET_MS is the product target (Lighthouse's "good" TBT). Every run reports the median
 *   against it; screens above it are listed in docs/performance.md as open work.
 * - GUARD_MS fails the build. It sits above today's measured medians (≤ ~175 ms, with
 *   single loads up to ~260 ms on a 4-vCPU VM) so it catches real regressions without failing
 *   on scheduler noise. Lower it as screens get cheaper; never raise it without a measured
 *   reason recorded in docs/performance.md.
 *
 * Program screens (PROGRAM_SCREENS), the coach's (COACH_SCREENS) and M6's (PROGRESS_SCREENS) are
 * also held to MAX_SHIFT: the sum of layout shifts no input explains, on every load, so a streamed
 * or lazy panel never pushes content once it has painted.
 *
 * The workout screens are measured as they are used (M4): the three workout routes with a workout
 * in progress on the device (the shared kit fixture, seeded into each fresh context's IndexedDB
 * before the load; sync runs against the real endpoint), and workout History's list and detail
 * with a full first page of finished workouts, synced through the real API as a device sends them.
 *
 * The coach screens as M5 finished them (COACH_SCREENS) are measured last, on coach fixtures
 * (e2e/coach-support.ts) in the zone they were seeded in: a long conversation (long-thread, a full
 * page of the thread view and one more exchange) and the Proposals inbox with two proposals
 * waiting, proposed by the composer's real turns. They are held to MAX_SHIFT too. Seeding a coach
 * fixture blanks the training profile (resetCoach), so only M6's screens are measured after them.
 * perf-coach.e2e.ts measures the 60-message conversation and an answer streaming.
 *
 * M6's screens (PROGRESS_SCREENS) come last, in ANALYTICS_TZ, each held to MAX_SHIFT: every
 * /progress view and one lift's detail on twelve-weeks (seeded once, the first time one is
 * measured), a weekly review on week-complete and a cycle review on block-end, each created
 * through the list's form action as a no-JS Create posts it (e2e/analytics-support.ts,
 * e2e/review-support.ts). A review opened for the first time is written up, so every load after
 * the first shows the stored write-up, as the owner's later visits do.
 */
const TARGET_MS = 200;
const GUARD_MS = 250;
const LOADS = 5;
const MAX_SHIFT = 0.01;
/** The hybrid fixture's week-1 strength session, whose lineage is known once it is seeded. */
const STRENGTH_SESSION = '/train/session/<strength>';
/** History with the hybrid fixture's version 1 and its decisions. */
const HISTORY = '/train/history';
/** Today once onboarding is complete and there is no program: the Build card over the summary. */
const TODAY_BUILD = '/today (build)';
/** Today with the 'today' fixture's week 1 around the server's today: its sessions and Up next. */
const TODAY_PROGRAM = '/today (program)';
const PROGRAM_SCREENS = [TODAY_BUILD, TODAY_PROGRAM, '/train', STRENGTH_SESSION, HISTORY];
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
/** The long-thread fixture's conversation, with its newest page of messages on screen. */
const COACH_THREAD = '/coach/<long thread>';
/** The Proposals inbox with the swap and the next cycle waiting, each from its own conversation. */
const COACH_INBOX = '/coach/proposals (inbox)';
/** The turns that propose the inbox's two changes on the split-squat-week fixture. */
const COACH_PROPOSALS = ['I hate Bulgarian split squats, so replace them', 'Plan my next cycle'];
const COACH_SCREENS = [COACH_THREAD, COACH_INBOX];
/** One lift's detail on twelve-weeks: the squat, rising every week. */
const EXERCISE_DETAIL = '/progress/exercises/<squat>';
/** A weekly review of week-complete's week, and a cycle review of block-end's block. */
const WEEKLY_REVIEW = '/progress/reviews/<weekly>';
const CYCLE_REVIEW = '/progress/reviews/<cycle>';
/** Each M6 screen: its fixture or review scenario, and what it shows once loaded. */
const M6: Record<string, { seed: ReviewScenario | 'twelve-weeks'; shows: string }> = {
	'/progress (twelve weeks)': { seed: 'twelve-weeks', shows: 'overview' },
	'/progress?view=strength': { seed: 'twelve-weeks', shows: 'strength' },
	'/progress?view=running': { seed: 'twelve-weeks', shows: 'running' },
	'/progress?view=general': { seed: 'twelve-weeks', shows: 'general' },
	[EXERCISE_DETAIL]: { seed: 'twelve-weeks', shows: 'exercise-detail' },
	[WEEKLY_REVIEW]: { seed: 'week-complete', shows: 'weekly-review' },
	[CYCLE_REVIEW]: { seed: 'block-end', shows: 'cycle-review' }
};
const PROGRESS_SCREENS = Object.keys(M6);
const SCREENS = [
	'/',
	'/today',
	TODAY_BUILD,
	TODAY_PROGRAM,
	'/train',
	STRENGTH_SESSION,
	HISTORY,
	'/progress',
	WORKOUT_HISTORY,
	WORKOUT_DETAIL,
	...Object.keys(ACTIVE_WORKOUTS),
	'/coach',
	'/profile',
	'/profile/security',
	'/profile/equipment',
	'/profile/schedule',
	'/onboarding',
	// Last: seeding them blanks the training profile.
	...COACH_SCREENS,
	// After the coach's: each seed starts from no program, log or review.
	...PROGRESS_SCREENS
];

interface Seeded {
	url: string;
	restore: () => Promise<void>;
	/** Run in each fresh context before the load: what this device holds. */
	prepare?: (page: Page) => Promise<void>;
	/** The test id the loaded screen shows once it is in the state measured. */
	shows?: string;
}

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

/** The coach screen `path` on its fixture: the URL to load, and the coach emptied after. */
async function seedCoachScreen(path: string, request: APIRequestContext): Promise<Seeded> {
	const restore = () => resetCoach(request);
	if (path === COACH_THREAD) {
		const { threads } = await seedCoach(request, 'long-thread');
		return { url: `/coach/${threads.long}`, restore, shows: 'coach-message' };
	}
	await seedCoach(request, 'split-squat-week');
	for (const text of COACH_PROPOSALS) {
		const turn = await postTurn(request, text);
		expect(turn.status, text).toBe(200);
		expect(turn.events.at(-1), text).toEqual({ type: 'done', status: 'completed' });
	}
	const [waiting] = await query<{ n: number }>(
		`select count(*)::int as n from coach_proposals where status = 'proposed'`
	);
	expect(waiting?.n, 'proposals waiting in the inbox').toBe(COACH_PROPOSALS.length);
	return { url: '/coach/proposals', restore, shows: 'inbox-row' };
}

/** The fixture M6's screens were last seeded on, so the /progress screens share one seed. */
let analytics: { seed: string; seeded: SeededAnalytics } | undefined;

/** Create the seeded review through the list's form action, as a no-JS Create posts it: its URL. */
async function createReview(request: APIRequestContext, seeded: SeededReview): Promise<string> {
	const { review } = seeded;
	const { action, form } =
		review.kind === 'weekly'
			? { action: 'create', form: { weekStartsOn: review.weekStartsOn } }
			: {
					action: 'createCycle',
					form: { programId: seeded.programId!, blockLineage: review.blockLineageId }
				};
	const response = await request.post(`/progress/reviews?/${action}`, {
		headers: SAME_ORIGIN,
		form,
		maxRedirects: 0
	});
	expect(response.status(), `creating the ${review.kind} review`).toBe(303);
	return new URL(response.headers().location!, 'https://coach.test').pathname;
}

/** The URL of the /progress screen `path` on twelve-weeks. */
function progressUrl(path: string, seeded: SeededAnalytics): string {
	if (path === EXERCISE_DETAIL) return `/progress/exercises/${seeded.exercises.back_squat}`;
	return path.replace(' (twelve weeks)', '');
}

/** M6's screen `path` on its fixture: the URL to load (nothing to restore: afterAll resets). */
async function seedProgressScreen(path: string, request: APIRequestContext): Promise<Seeded> {
	const { seed, shows } = M6[path]!;
	const restore = async () => {};
	if (seed === 'twelve-weeks') {
		if (analytics?.seed !== seed) {
			analytics = { seed, seeded: await seedAnalytics(request, 'twelve-weeks') };
		}
		return { url: progressUrl(path, analytics.seeded), restore, shows };
	}
	analytics = undefined;
	const url = await createReview(request, await seedReview(request, seed));
	return { url, restore, shows };
}

/**
 * Seed what `path` is measured on through the fixture route: the URL to load, and how to put the
 * owner's onboarding back afterwards, so the screens measured next see it as they would have.
 */
async function seedFor(path: string, request: APIRequestContext): Promise<Seeded> {
	const none = { url: path, restore: async () => {} };
	if (COACH_SCREENS.includes(path)) return seedCoachScreen(path, request);
	if (PROGRESS_SCREENS.includes(path)) return seedProgressScreen(path, request);
	const active = ACTIVE_WORKOUTS[path];
	if (active) {
		// Ad hoc, so each start syncs (the fixture's planned session is not in this database).
		const kit = adHoc((await workoutDay())[active.kind]);
		const url = path.replace(' (active)', '');
		// Every load's device holds its own workout; each one's start syncs, so clear them after.
		const prepare = async (page: Page) => {
			await seedWorkout(page, kit);
		};
		return { url, restore: resetPrograms, prepare, shows: active.shows };
	}
	if (path === WORKOUT_HISTORY || path === WORKOUT_DETAIL) {
		await resetPrograms();
		const newest = await seedHistory(request);
		const url = path === WORKOUT_DETAIL ? `${WORKOUT_HISTORY}/${newest}` : path;
		return {
			url,
			restore: resetPrograms,
			shows: path === WORKOUT_DETAIL ? 'workout-detail' : 'workout-row'
		};
	}
	if (!PROGRAM_SCREENS.includes(path)) return none;
	// Train is measured in its program state: a hybrid week, strength, runs and Muay Thai;
	// the session screen on that week's strength session, its longest; History on its versions.
	const fixture = path === TODAY_BUILD || path === TODAY_PROGRAM ? 'today' : 'hybrid';
	const seeded = await seedProgram(request, { fixture, start: 'this_week' });
	if (path === '/train' || path === HISTORY) return none;
	if (path === STRENGTH_SESSION) {
		const strength = seeded.sessions.find((s) => s.title === 'Full body');
		return { ...none, url: `/train/session/${strength!.lineage}` };
	}
	// Today picks its state from onboarding: complete, with the program or (removed) without it.
	if (path === TODAY_BUILD) await resetPrograms();
	const [before] = await query<{ at: Date | null }>(
		'select onboarding_completed_at as at from athlete_profiles'
	);
	await query('update athlete_profiles set onboarding_completed_at = now()');
	return {
		url: '/today',
		restore: async () => {
			await query('update athlete_profiles set onboarding_completed_at = $1', [before?.at ?? null]);
		}
	};
}

test.describe('main-thread budget (4× CPU)', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'CPU throttling uses CDP');
	test.afterAll(() => resetPrograms());

	for (const path of SCREENS) {
		test(`${path} blocks the main thread ≤ ${GUARD_MS} ms while loading`, async ({
			browser,
			request
		}, testInfo) => {
			const { url, restore, prepare, shows } = await seedFor(path, request);
			const samples: number[] = [];
			const shifts: number[] = [];
			try {
				for (let i = 0; i < LOADS; i++) {
					// A fresh context per load: cold caches, no service worker yet. Signed in (the
					// project's storage state), except for the sign-in screen, which only a signed-out
					// browser sees.
					const context = await browser.newContext(
						path === '/'
							? { ...testInfo.project.use, storageState: { cookies: [], origins: [] } }
							: COACH_SCREENS.includes(path)
								? { ...testInfo.project.use, timezoneId: COACH_TZ }
								: PROGRESS_SCREENS.includes(path)
									? { ...testInfo.project.use, timezoneId: ANALYTICS_TZ }
									: testInfo.project.use
					);
					const page = await context.newPage();
					await page.addInitScript(() => {
						const tasks: number[] = [];
						const shifts: number[] = [];
						Object.assign(window, { __longTasks: tasks, __shifts: shifts });
						new PerformanceObserver((list) => {
							for (const entry of list.getEntries()) tasks.push(entry.duration);
						}).observe({ type: 'longtask', buffered: true });
						new PerformanceObserver((list) => {
							for (const entry of list.getEntries() as (PerformanceEntry & {
								value: number;
								hadRecentInput: boolean;
							})[]) {
								if (!entry.hadRecentInput) shifts.push(entry.value);
							}
						}).observe({ type: 'layout-shift', buffered: true });
					});
					if (prepare) await prepare(page);
					const cdp = await context.newCDPSession(page);
					await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
					await page.goto(url, { waitUntil: 'load' });
					await page.waitForTimeout(1_500);
					// Measured in the state it is listed under, not an empty or failed one.
					if (shows) await expect(page.getByTestId(shows).first()).toBeVisible();
					const observed = await page.evaluate(() => {
						const w = window as unknown as { __longTasks: number[]; __shifts: number[] };
						return { tasks: w.__longTasks, shifts: w.__shifts };
					});
					samples.push(observed.tasks.reduce((sum, d) => sum + Math.max(0, d - 50), 0));
					shifts.push(observed.shifts.reduce((sum, v) => sum + v, 0));
					await context.close();
				}
			} finally {
				await restore();
			}
			samples.sort((a, b) => a - b);
			const median = samples[Math.floor(samples.length / 2)]!;
			const status = median <= TARGET_MS ? 'meets target' : `above the ${TARGET_MS} ms target`;
			testInfo.annotations.push({
				type: 'blocking time (ms)',
				description: `median ${Math.round(median)} (${status}) · runs ${samples.map(Math.round).join(', ')}`
			});
			expect(median, `${path}: ${samples.map(Math.round).join(', ')} ms`).toBeLessThanOrEqual(
				GUARD_MS
			);
			if ([...PROGRAM_SCREENS, ...COACH_SCREENS, ...PROGRESS_SCREENS].includes(path)) {
				const worst = Math.max(...shifts);
				testInfo.annotations.push({
					type: 'layout shift',
					description: `worst ${worst.toFixed(4)} · runs ${shifts.map((s) => s.toFixed(4)).join(', ')}`
				});
				expect(worst, `${path}: layout shift on a load`).toBeLessThanOrEqual(MAX_SHIFT);
			}
		});
	}
});
