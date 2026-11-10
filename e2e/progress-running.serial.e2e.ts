/**
 * Progress → Running (src/routes/(app)/progress/RunningView.svelte), server-rendered from the
 * running service. On the twelve-weeks history the weekly mileage, the longest run and the pace
 * of each run type (intervals, tempo, long, recovery) equal the SQL oracles (e2e/oracles/) in the
 * profile's unit, km and then mi, converted exactly; best efforts and the reported race are
 * labelled by source; period links keep the view; a first week is told what appears and when;
 * axe is clean in both themes on a phone and in a desktop window, with and without JavaScript.
 *
 * Serial: the history is the one owner's, which every browser and worker shares.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import {
	ANALYTICS_TZ,
	auditBothThemes,
	query,
	resetAnalytics,
	seedAnalytics,
	type SeededAnalytics
} from './analytics-support';
import { DESKTOP, boxOf, expectNoSideScroll } from './desktop';
import { effortsBetween } from './oracles/running-efforts';
import { paceByType, weeklyRunning } from './oracles/running';
import { captureScreen, gotoHydrated } from './support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

const RUNNING = '/progress?view=running';
const METRES_PER_MILE = 1609.344;
type Unit = 'km' | 'mi';
const per = (unit: Unit) => (unit === 'km' ? 1000 : METRES_PER_MILE);

const periodLink = (page: Page, name: string) =>
	page.getByRole('navigation', { name: 'Period', exact: true }).getByRole('link', { name });
const valueOf = async (locator: Locator) => Number(await locator.getAttribute('data-value'));
const numberIn = async (locator: Locator) =>
	parseFloat((await locator.textContent())!.replace(/,/g, ''));
const tableRows = (frame: Locator) => frame.getByTestId('chart-table').locator('tbody tr');
/** '5:42 /km' → 342. */
const secondsOf = (text: string) => {
	const [, m, s] = /(\d+):(\d\d)/.exec(text)!;
	return Number(m) * 60 + Number(s);
};

/** The period's complete weeks: `weeks` weeks ending the Sunday before this week. */
const periodOf = (seeded: SeededAnalytics, weeks: number) => ({
	from: addDays(seeded.weekStart, -7 * weeks),
	to: addDays(seeded.weekStart, -1)
});

/** The mileage table twin: the period's complete weeks, then this week so far, in `unit`. */
async function expectMileage(page: Page, seeded: SeededAnalytics, weeks: number, unit: Unit) {
	const oracle = (await weeklyRunning(seeded.today)).slice(-(weeks + 1));
	const frame = page.getByTestId('chart-mileage');
	await expect(frame.getByTestId('chart-table').locator('thead')).toContainText(`(${unit})`);
	const rows = tableRows(frame);
	await expect(rows).toHaveCount(weeks + 1);
	await expect(rows.last()).toHaveAttribute('data-in-progress', 'true');
	for (const [i, week] of oracle.entries()) {
		const shown = await numberIn(rows.nth(i).locator('td').first());
		const expected = week.metres / per(unit);
		expect(Math.abs(shown - expected), `mileage, week of ${week.weekStart}`).toBeLessThanOrEqual(
			0.05 + 1e-9
		);
	}
}

/** Each run type's pace over the period's complete weeks, in s/km behind it and `unit` on it. */
async function expectPaces(page: Page, seeded: SeededAnalytics, weeks: number, unit: Unit) {
	const { from, to } = periodOf(seeded, weeks);
	const oracle = await paceByType(from, to);
	const types = page.getByTestId('pace-type');
	for (const type of ['interval_run', 'tempo_run', 'long_run'])
		await expect(types.and(page.locator(`[data-type="${type}"]`))).toHaveCount(1);
	for (const row of oracle) {
		const pace = types.and(page.locator(`[data-type="${row.sessionType}"]`)).getByTestId('pace');
		expect(await valueOf(pace), `${row.sessionType} s/km`).toBeCloseTo(row.secondsPerKm, 3);
		const text = (await pace.textContent())!;
		expect(text).toContain(`/${unit}`);
		const expected = (row.secondsPerKm * per(unit)) / 1000;
		expect(Math.abs(secondsOf(text) - expected), `${row.sessionType} pace`).toBeLessThanOrEqual(
			0.5 + 1e-6
		);
	}
	await expect(page.getByTestId('running-pace')).toContainText(`min/${unit} (lower is faster)`);
}

/** The longest run of the period's complete weeks, in metres behind it and `unit` on it. */
async function expectLongest(page: Page, seeded: SeededAnalytics, weeks: number, unit: Unit) {
	const complete = (await weeklyRunning(seeded.today)).slice(-(weeks + 1), -1);
	const metres = Math.max(...complete.map((w) => w.longestMetres));
	const shown = page.getByTestId('longest-run');
	expect(await valueOf(shown)).toBeCloseTo(metres, 1);
	await expect(shown).toHaveText(
		`${(Math.round((metres / per(unit)) * 10) / 10).toLocaleString('en-US')} ${unit}`
	);
}

test.describe('twelve weeks', () => {
	let seeded: SeededAnalytics;

	test.beforeAll(async ({ request }) => {
		seeded = await seedAnalytics(request, 'twelve-weeks');
	});

	test('mileage, the longest run and pace by type equal the oracles in km', async ({ page }) => {
		await gotoHydrated(page, '/progress');
		await page
			.getByRole('navigation', { name: 'Progress views' })
			.getByRole('link', { name: 'Running' })
			.click();
		await expect(page).toHaveURL(/\/progress\?view=running$/);
		await expect(page.getByTestId('running')).toHaveAttribute('data-stage', 'history');

		await expectMileage(page, seeded, 12, 'km');
		await expectPaces(page, seeded, 12, 'km');
		await expectLongest(page, seeded, 12, 'km');
		// The plan is outlined beside each week's distance, and heart rate is given by run type.
		await expect(
			page.getByTestId('chart-mileage').getByTestId('chart-table').locator('thead')
		).toContainText('Planned');
		await expect(page.getByTestId('running-hr')).toContainText('Long run');
	});

	test('a mile owner sees the same figures converted exactly', async ({ page }) => {
		await query(`update athlete_profiles set distance_unit = 'mi'`);
		try {
			await gotoHydrated(page, RUNNING);
			await expectMileage(page, seeded, 12, 'mi');
			await expectPaces(page, seeded, 12, 'mi');
			await expectLongest(page, seeded, 12, 'mi');
			await expect(page.getByTestId('tile-mileage')).toContainText(' mi');
		} finally {
			await query(`update athlete_profiles set distance_unit = 'km'`);
		}
	});

	test('best efforts and the reported race are labelled by their source', async ({ page }) => {
		await gotoHydrated(page, RUNNING);
		const oracle = await effortsBetween(periodOf(seeded, 12).from, seeded.today);
		expect(oracle.some((e) => e.source === 'reported')).toBe(true);
		expect(oracle.some((e) => e.source === 'best_effort')).toBe(true);
		const items = page.getByTestId('effort');
		await expect(items).toHaveCount(oracle.length);
		for (const e of oracle) {
			const label = e.source === 'reported' ? 'Reported' : 'Best effort';
			const item = items.and(page.locator(`[data-label="${label}"][data-value="${e.seconds}"]`));
			await expect(item, `${e.distance} ${label}`).toHaveCount(1);
			if (e.eventName) await expect(item).toContainText(e.eventName);
		}
		await expect(items.filter({ hasText: 'Riverside 10K' })).toContainText('10 km · Reported');
	});

	test('a period link keeps the view and the figures follow', async ({ page }) => {
		await gotoHydrated(page, RUNNING);
		await periodLink(page, 'Last 4 weeks').click();
		await expect(page).toHaveURL(/\/progress\?view=running&period=4w$/);
		await expect(page.getByTestId('period-content')).toHaveAttribute('aria-busy', 'false');
		await expectMileage(page, seeded, 4, 'km');
		await expectPaces(page, seeded, 4, 'km');
		// Week 8's race is before the last 4 weeks.
		await expect(
			page.getByTestId('effort').and(page.locator('[data-label="Reported"]'))
		).toHaveCount(0);

		await page.goBack();
		await expect(page).toHaveURL(/\/progress\?view=running$/);
		await expectMileage(page, seeded, 12, 'km');
	});

	test('axe is clean in both themes; the phone screen is captured, and 320 px fits', async ({
		page
	}, testInfo) => {
		await page.setViewportSize({ width: 393, height: 659 });
		await gotoHydrated(page, RUNNING);
		await auditBothThemes(page, 'Progress running');
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'progress-running-phone');
		await page.setViewportSize({ width: 320, height: 640 });
		await expectNoSideScroll(page);
	});

	test.describe('in a desktop window', () => {
		test.use({ ...DESKTOP });

		test('the pace multiples share a row and the sections pair up', async ({ page }, testInfo) => {
			await gotoHydrated(page, RUNNING);
			const types = await page.getByTestId('pace-type').all();
			const [first, second] = [await boxOf(types[0]!), await boxOf(types[1]!)];
			expect(Math.abs(first.y - second.y), 'paces share a row').toBeLessThan(1);
			const [long, efforts] = [
				await boxOf(page.getByTestId('running-long')),
				await boxOf(page.getByTestId('running-efforts'))
			];
			expect(Math.abs(long.y - efforts.y), 'long runs and efforts pair up').toBeLessThan(1);
			await expectNoSideScroll(page);
			await auditBothThemes(page, 'Progress running, desktop');
			await captureScreen(page, testInfo, 'progress-running-desktop');
		});
	});

	test.describe('without JavaScript', () => {
		test.use({ javaScriptEnabled: false });

		test('the server renders the figures and the table twins hold the oracle values', async ({
			page
		}) => {
			await page.goto(RUNNING);
			await expectMileage(page, seeded, 12, 'km');
			await expectPaces(page, seeded, 12, 'km');
			await expect(page.getByTestId('chart-mileage').getByTestId('chart-no-js')).toHaveText(
				'Chart needs JavaScript'
			);
			await periodLink(page, 'Last 4 weeks').click();
			await expect(page).toHaveURL(/\/progress\?view=running&period=4w$/);
			await expectMileage(page, seeded, 4, 'km');
		});
	});
});

test.describe('a new runner', () => {
	test.afterAll(async () => {
		await resetAnalytics();
	});

	test('in the first week: what appears and when, the week so far, and no chart', async ({
		page,
		request
	}) => {
		const seeded = await seedAnalytics(request, 'first-week');
		await gotoHydrated(page, RUNNING);
		await expect(page.getByTestId('chart-plot')).toHaveCount(0);
		const view = page.getByTestId('running');
		// The fixture logs up to yesterday: the week's first run is Tuesday's intervals.
		if (seeded.today <= addDays(seeded.weekStart, 1)) {
			await expect(view).toHaveAttribute('data-stage', 'new');
			await expect(
				page.getByRole('heading', { name: 'Your running trends start with your first run' })
			).toBeVisible();
			return;
		}
		await expect(view).toHaveAttribute('data-stage', 'first_week');
		await expect(
			page.getByRole('heading', { name: 'Your first week of running is under way' })
		).toBeVisible();
		await expect(page.getByTestId('tile-mileage').getByTestId('so-far')).toContainText(
			'This week so far:'
		);
		await auditBothThemes(page, 'Progress running, first week');
	});
});
