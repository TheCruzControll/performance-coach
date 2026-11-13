import { expect, test, type APIRequestContext } from '@playwright/test';
import { ANALYTICS_TZ, seedAnalytics, type SeededAnalytics } from './analytics-support';
import { expectLoadBudget, GUARD_MS, type Seeded } from './load-budget';
import { resetReviews, seedReview, type ReviewScenario, type SeededReview } from './review-support';
import { SAME_ORIGIN } from './support';

/**
 * The main-thread budget while M6's screens load (e2e/load-budget.ts: median blocking time of 5
 * cold loads at 4× CPU, within GUARD_MS), in ANALYTICS_TZ, each also held to MAX_SHIFT: every
 * /progress view and one lift's detail on twelve-weeks (seeded once, the first time one is
 * measured), a weekly review on week-complete and a cycle review on block-end, each created
 * through the list's form action as a no-JS Create posts it (e2e/analytics-support.ts,
 * e2e/review-support.ts). A review opened for the first time is written up, so every load after
 * the first shows the stored write-up, as the owner's later visits do. Each seed starts from no
 * program, log or review and blanks the training profile, so these screens have a file of their
 * own, which empties it all after the last. perf.e2e.ts measures the app's other screens the same
 * way.
 */
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
		// A browser's no-JS post asks for HTML; Playwright's default */* gets the action's JSON.
		headers: { ...SAME_ORIGIN, accept: 'text/html' },
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
	const context = { timezoneId: ANALYTICS_TZ };
	if (seed === 'twelve-weeks') {
		if (analytics?.seed !== seed) {
			analytics = { seed, seeded: await seedAnalytics(request, 'twelve-weeks') };
		}
		return { url: progressUrl(path, analytics.seeded), restore, shows, context };
	}
	analytics = undefined;
	const url = await createReview(request, await seedReview(request, seed));
	return { url, restore, shows, context };
}

test.describe('main-thread budget (4× CPU)', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'CPU throttling uses CDP');
	test.afterAll(({ request }) => resetReviews(request));

	for (const path of PROGRESS_SCREENS) {
		test(`${path} blocks the main thread ≤ ${GUARD_MS} ms while loading`, async ({
			browser,
			request
		}, testInfo) => {
			await expectLoadBudget(path, await seedProgressScreen(path, request), {
				browser,
				testInfo,
				maxShift: true
			});
		});
	}
});
