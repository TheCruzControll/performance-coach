/**
 * The review specs' support (`*.serial.e2e.ts`): a review scenario seeded through the real
 * services by the analytics test route, at dates the server works out from the owner's today.
 *
 * - Pin the browser to the zone the route records: `test.use({ timezoneId: ANALYTICS_TZ })`.
 * - Use the dates seedReview returns (`review`: the week, or the block, to review); never work
 *   one out in the spec.
 * - Compare reviews, their revisions, program versions and decisions with e2e/oracles/reviews.ts,
 *   which reads them in SQL with no app code.
 *
 * Written once and never edited: a later slice adds a scenario file on the server
 * (src/lib/server/test-support/analytics-fixtures/) and an oracle file here.
 */
import type { APIRequestContext } from '@playwright/test';
import type { ReviewTarget } from '../src/lib/server/test-support/analytics-fixtures/reviews';
import { seedAnalytics, type SeededAnalytics } from './analytics-support';
import { resetCoach } from './coach-support';
import { resetPrograms } from './program-support';

export { ANALYTICS_TZ, auditBothThemes, query } from './analytics-support';
export type { ReviewTarget };

/** The review scenarios (src/lib/server/test-support/analytics-fixtures/reviews.ts). */
export type ReviewScenario =
	| 'week-almost-complete'
	| 'week-complete'
	| 'week-late'
	| 'next-week-deload'
	| 'block-end'
	| 'block-end-late';

export interface SeededReview extends SeededAnalytics {
	review: ReviewTarget;
}

/**
 * No program, log, proposal or review (M3's resetPrograms), no coach row or fault and the turn
 * rate limit cleared (M5's resetCoach, which also blanks the training profile).
 */
export async function resetReviews(request: APIRequestContext): Promise<void> {
	await resetPrograms();
	await resetCoach(request);
}

/** Reset, then seed `scenario` in ANALYTICS_TZ: its ids, its dates and what to review. */
export async function seedReview(
	request: APIRequestContext,
	scenario: ReviewScenario
): Promise<SeededReview> {
	await resetReviews(request);
	return (await seedAnalytics(request, scenario)) as SeededReview;
}
