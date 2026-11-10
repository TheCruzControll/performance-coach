/**
 * Progress → Strength (src/routes/(app)/progress/StrengthView.svelte), server-rendered from the
 * strength service. On the twelve-weeks history each key lift's best estimated 1RM, the weekly
 * tonnage, the shown week's hard sets per muscle group, the RPE deviation and the PRs equal the
 * SQL oracles (e2e/oracles/), with and without JavaScript; estimates say so; the deload week's
 * range is its scaled one; period links keep the view and lifts open their page; a first week is
 * told what appears and when; axe is clean in both themes on a phone and in a desktop window.
 *
 * Serial: the history is the one owner's, which every browser and worker shares.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import { MUSCLE_GROUP_LABEL } from '../src/lib/domain/training/vocabulary';
import {
	ANALYTICS_TZ,
	auditBothThemes,
	resetAnalytics,
	seedAnalytics,
	type SeededAnalytics
} from './analytics-support';
import { DESKTOP, boxOf, expectNoSideScroll } from './desktop';
import { bestE1rmBetween } from './oracles/exercise';
import { hardSetsByGroup, prRows, rpeSummary, weeklyTonnage } from './oracles/strength';
import { captureScreen, gotoHydrated } from './support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

const STRENGTH = '/progress?view=strength';
const periodLink = (page: Page, name: string) =>
	page.getByRole('navigation', { name: 'Period', exact: true }).getByRole('link', { name });
const valueOf = async (locator: Locator) => Number(await locator.getAttribute('data-value'));
const numberIn = async (locator: Locator) =>
	parseFloat((await locator.textContent())!.replace(/,/g, ''));
const tableRows = (frame: Locator) => frame.getByTestId('chart-table').locator('tbody tr');

/** The period's complete weeks: `weeks` weeks ending the Sunday before this week. */
const periodOf = (seeded: SeededAnalytics, weeks: number) => ({
	from: addDays(seeded.weekStart, -7 * weeks),
	to: addDays(seeded.weekStart, -1)
});

const keyOf = (seeded: SeededAnalytics, id: string) =>
	Object.entries(seeded.exercises).find(([, exercise]) => exercise === id)![0];

/** Each key lift's best estimated 1RM equals the oracle's over the period's complete weeks. */
async function expectBestE1rms(page: Page, seeded: SeededAnalytics, weeks: number) {
	const { from, to } = periodOf(seeded, weeks);
	const lifts = await page.getByTestId('key-lift').all();
	expect(lifts.length, 'key lifts are charted').toBeGreaterThan(0);
	expect(lifts.length).toBeLessThanOrEqual(6);
	for (const lift of lifts) {
		const key = keyOf(seeded, (await lift.getAttribute('data-exercise'))!);
		const best = await bestE1rmBetween(key, from, to);
		expect(await valueOf(lift.getByTestId('best-e1rm')), `${key} over ${weeks} weeks`).toBeCloseTo(
			best!,
			1
		);
		await expect(lift).toContainText('Estimated');
	}
}

/** The tonnage table twin: the period's complete weeks, then this week so far, as the oracle. */
async function expectTonnage(page: Page, seeded: SeededAnalytics, weeks: number) {
	const oracle = (await weeklyTonnage(seeded.today)).slice(-(weeks + 1));
	const rows = tableRows(page.getByTestId('chart-tonnage'));
	await expect(rows).toHaveCount(weeks + 1);
	await expect(rows.last()).toHaveAttribute('data-in-progress', 'true');
	for (const [i, week] of oracle.entries()) {
		const cell = rows.nth(i).locator('td').first();
		expect(await numberIn(cell), `tonnage, week of ${week.weekStart}`).toBeCloseTo(
			week.tonnageKg,
			-1
		);
	}
}

/** The shown (last complete) week's hard sets per group, as the oracle counts them. */
async function expectGroups(page: Page, seeded: SeededAnalytics) {
	const week = addDays(seeded.weekStart, -7);
	const oracle = (await hardSetsByGroup(seeded.today)).filter((row) => row.weekStart === week);
	const rows = tableRows(page.getByTestId('chart-groups'));
	expect(await rows.count(), 'the major groups are judged').toBeGreaterThan(0);
	for (const row of await rows.all()) {
		const label = (await row.locator('th').textContent())!.trim();
		const group = Object.entries(MUSCLE_GROUP_LABEL).find(([, name]) => name === label)![0];
		const expected = oracle.find((o) => o.group === group)?.hardSets ?? 0;
		expect(await numberIn(row.locator('td').first()), `${label} hard sets`).toBeCloseTo(
			expected,
			1
		);
	}
}

test.describe('twelve weeks', () => {
	let seeded: SeededAnalytics;

	test.beforeAll(async ({ request }) => {
		seeded = await seedAnalytics(request, 'twelve-weeks');
	});

	test('lifts, tonnage, muscle groups, RPE and PRs equal the oracles', async ({ page }) => {
		await gotoHydrated(page, '/progress');
		await page
			.getByRole('navigation', { name: 'Progress views' })
			.getByRole('link', { name: 'Strength' })
			.click();
		await expect(page).toHaveURL(/\/progress\?view=strength$/);
		await expect(page.getByTestId('strength')).toHaveAttribute('data-stage', 'history');

		await expectBestE1rms(page, seeded, 12);
		await expectTonnage(page, seeded, 12);
		await expectGroups(page, seeded);

		const { from, to } = periodOf(seeded, 12);
		const rpe = await rpeSummary(from, to);
		expect(await valueOf(page.getByTestId('tile-rpe-deviation')), 'RPE deviation').toBeCloseTo(
			rpe.deviation!,
			1
		);
		expect(await valueOf(page.getByTestId('tile-avg-rpe')), 'average RPE').toBeCloseTo(
			rpe.meanRpe!,
			1
		);

		// Every record of the period and this week, against all earlier training.
		const records = [];
		for (const key of Object.keys(seeded.exercises))
			records.push(...(await prRows(key)).filter((pr) => pr.day >= from && pr.day <= seeded.today));
		const items = page.getByTestId('strength-pr');
		await expect(items).toHaveCount(Math.min(8, records.length));
		if (records.length > 8)
			await expect(page.getByTestId('strength-pr-total')).toContainText(`of ${records.length}`);
		const values = records.map((pr) => pr.value);
		for (const item of await items.all()) {
			const value = await valueOf(item);
			expect(
				values.some((v) => Math.abs(v - value) < 0.05),
				`PR ${value}`
			).toBe(true);
		}
		await expect(items.filter({ hasText: 'Estimated 1RM' }).first()).toContainText('Estimated');
	});

	test('the deload week’s range is the full range scaled by its volume', async ({ page }) => {
		await gotoHydrated(page, STRENGTH);
		const range = async (week: string) => {
			const row = page.locator(`[data-testid="range-week"][data-week="${week}"]`);
			const text = (await row.locator('td').first().textContent())!;
			const [, low, high] = /([\d.]+)–([\d.]+) sets/.exec(text)!;
			return { row, low: Number(low), high: Number(high) };
		};
		// Weeks 4 and 8 of the history are deloads at 60 %; week 12 is a full week.
		const full = await range(addDays(seeded.weekStart, -7));
		const deload = await range(addDays(seeded.weekStart, -35));
		expect(deload.low).toBeCloseTo(full.low * 0.6, 1);
		expect(deload.high).toBeCloseTo(full.high * 0.6, 1);
		await expect(deload.row).toContainText('60 % volume');
		await expect(full.row).not.toContainText('% volume');
		await expect(page.getByTestId('chart-groups')).toContainText(
			'From the profile this block was planned with'
		);
	});

	test('a period link keeps the view, and a lift opens its page', async ({ page }) => {
		await gotoHydrated(page, STRENGTH);
		await periodLink(page, 'Last 4 weeks').click();
		await expect(page).toHaveURL(/\/progress\?view=strength&period=4w$/);
		await expect(page.getByTestId('period-content')).toHaveAttribute('aria-busy', 'false');
		await expectBestE1rms(page, seeded, 4);
		await expectTonnage(page, seeded, 4);

		await page.goBack();
		await expect(page).toHaveURL(/\/progress\?view=strength$/);
		await expectTonnage(page, seeded, 12);

		const squat = page.getByTestId('key-lift').filter({ hasText: 'Back squat' });
		await squat.getByRole('link', { name: 'Back squat' }).click();
		await expect(page).toHaveURL(new RegExp(`/progress/exercises/${seeded.exercises.back_squat}$`));
		await expect(page.getByTestId('exercise-detail')).toBeVisible();
	});

	test('axe is clean in both themes; the phone screen is captured, and 320 px fits', async ({
		page
	}, testInfo) => {
		await page.setViewportSize({ width: 393, height: 659 });
		await gotoHydrated(page, STRENGTH);
		await auditBothThemes(page, 'Progress strength');
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'progress-strength-phone');
		await page.setViewportSize({ width: 320, height: 640 });
		await expectNoSideScroll(page);
	});

	test.describe('in a desktop window', () => {
		test.use({ ...DESKTOP });

		test('the lifts sit three a row and the volume charts pair up', async ({ page }, testInfo) => {
			await gotoHydrated(page, STRENGTH);
			const lifts = await page.getByTestId('key-lift').all();
			const [first, second] = [await boxOf(lifts[0]!), await boxOf(lifts[1]!)];
			expect(Math.abs(first.y - second.y), 'lifts share a row').toBeLessThan(1);
			const [tonnage, hard] = [
				await boxOf(page.getByTestId('tile-tonnage')),
				await boxOf(page.getByTestId('tile-hard_sets'))
			];
			expect(Math.abs(tonnage.y - hard.y), 'the volume tiles pair up').toBeLessThan(1);
			await expectNoSideScroll(page);
			await auditBothThemes(page, 'Progress strength, desktop');
			await captureScreen(page, testInfo, 'progress-strength-desktop');
		});
	});

	test.describe('without JavaScript', () => {
		test.use({ javaScriptEnabled: false });

		test('the server renders the figures and the table twins hold the oracle values', async ({
			page
		}) => {
			await page.goto(STRENGTH);
			await expectBestE1rms(page, seeded, 12);
			await expectTonnage(page, seeded, 12);
			await expectGroups(page, seeded);
			await expect(page.getByTestId('chart-tonnage').getByTestId('chart-no-js')).toHaveText(
				'Chart needs JavaScript'
			);
			await periodLink(page, 'Last 4 weeks').click();
			await expect(page).toHaveURL(/\/progress\?view=strength&period=4w$/);
			await expectTonnage(page, seeded, 4);
		});
	});
});

test.describe('a new lifter', () => {
	test.afterAll(async () => {
		await resetAnalytics();
	});

	test('in the first week: what appears and when, the week so far, and no chart', async ({
		page,
		request
	}) => {
		const seeded = await seedAnalytics(request, 'first-week');
		await gotoHydrated(page, STRENGTH);
		await expect(page.getByTestId('chart-plot')).toHaveCount(0);
		const view = page.getByTestId('strength');
		// On a Monday nothing is logged yet (the fixture logs up to yesterday).
		if (seeded.today === seeded.weekStart) {
			await expect(view).toHaveAttribute('data-stage', 'new');
			await expect(
				page.getByRole('heading', { name: 'Your strength trends start with your first lift' })
			).toBeVisible();
			return;
		}
		await expect(view).toHaveAttribute('data-stage', 'first_week');
		await expect(
			page.getByRole('heading', { name: 'Your first week of lifting is under way' })
		).toBeVisible();
		await expect(page.getByTestId('tile-tonnage').getByTestId('so-far')).toContainText(
			'This week so far:'
		);
		await auditBothThemes(page, 'Progress strength, first week');
	});
});
