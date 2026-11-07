/**
 * Training histories for the M6 dashboard specs (`*.serial.e2e.ts`): a fixture seeded through the
 * real services by the test-only route, at dates the server works out from the owner's today,
 * and what the specs compare the screens with.
 *
 * - Pin the browser to the zone the route records: `test.use({ timezoneId: ANALYTICS_TZ })`.
 * - Use the dates seedAnalytics returns; never work one out in the spec. The server's today is
 *   the one the dashboards show, on any weekday and in any machine zone.
 * - Compare a figure with e2e/oracles/, which recompute it in SQL with no app code, never with
 *   the code under test.
 *
 * Written once and never edited: a later slice adds a fixture file on the server and an oracle
 * file here.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { resetTrainingProfile, SAME_ORIGIN } from './support';

export { query } from './support';

/** The owner's zone in analytics specs: daylight saving, and far from UTC in the evening. */
export const ANALYTICS_TZ = 'America/Los_Angeles';

export interface SeededAnalytics {
	fixture: string;
	timeZone: string;
	/** The owner's today in ANALYTICS_TZ when the fixture was seeded, and its week's Monday. */
	today: string;
	weekStart: string;
	/** The Monday of the history's first week; null when nothing was planned or logged. */
	historyStart: string | null;
	programId: string | null;
	/** Catalogue key → exercise id. */
	exercises: Record<string, string>;
	/** Workout row ids by role: abandoned, deleted, inProgress, offPlan. */
	workouts: Record<string, string>;
	/** Planned-session lineages by role: skipped, moved, missed. */
	lineages: Record<string, string>;
}

/**
 * Start from nothing: every program, log, note, proposal and review (M3's resetPrograms) and the
 * training profile, which the fixtures write too.
 */
export async function resetAnalytics(): Promise<void> {
	await resetTrainingProfile();
}

/** Reset, then seed `fixture` (src/lib/server/test-support/analytics-fixtures) in ANALYTICS_TZ. */
export async function seedAnalytics(
	request: APIRequestContext,
	fixture: string
): Promise<SeededAnalytics> {
	await resetAnalytics();
	const response = await request.post('/api/test-support/analytics', {
		headers: SAME_ORIGIN,
		data: { fixture, timeZone: ANALYTICS_TZ },
		timeout: 30_000
	});
	expect(response.status(), `seeding '${fixture}'`).toBe(201);
	return (await response.json()) as SeededAnalytics;
}

/** No WCAG A/AA violations on the page as it is, in the dark theme and then the light one. */
export async function auditBothThemes(page: Page, label: string): Promise<void> {
	for (const theme of ['dark', 'light'] as const) {
		await page.evaluate((t) => {
			if (t === 'dark') delete document.documentElement.dataset.theme;
			else document.documentElement.dataset.theme = t;
		}, theme);
		await page.waitForTimeout(250); // the theme's colour transitions settle
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		expect(
			violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`)),
			`${label} (${theme})`
		).toEqual([]);
	}
	await page.evaluate(() => delete document.documentElement.dataset.theme);
}
