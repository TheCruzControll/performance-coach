/**
 * Progress → one exercise (src/routes/(app)/progress/exercises/[id]): is this lift going up? On
 * the twelve-weeks history its best e1RM, rep maxes and PRs equal the SQL oracles (e2e/oracles/)
 * through data-value; the profile's tested bench max reads as measured; a period switch keeps the
 * frame; the keyboard scrubs the chart to a week's value; an unknown id is a 404; a failed load
 * shows Retry; offline is the designed state; a first week waits for two sessions; axe is clean
 * in both themes on a phone and on a desktop window, where the chart sits beside the rep maxes.
 * The trends (the e1RM tile, the chart, the records) load after the header's verdict: a client
 * navigation holds their room until they fill it, and code that fails to load offers Retry.
 *
 * Serial: the history is the one owner's, which every browser and worker shares.
 */
import {
	expect,
	test,
	type APIResponse,
	type Locator,
	type Page,
	type Route
} from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import {
	ANALYTICS_TZ,
	auditBothThemes,
	resetAnalytics,
	seedAnalytics,
	type SeededAnalytics
} from './analytics-support';
import { DESKTOP, boxOf, expectNoShift, expectNoSideScroll } from './desktop';
import { bestE1rmBetween } from './oracles/exercise';
import { prRows, repMaxes } from './oracles/strength';
import { captureScreen, gotoHydrated, ORIGIN } from './support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

const pathOf = (seeded: SeededAnalytics, key: string, query = '') =>
	`/progress/exercises/${seeded.exercises[key]}${query}`;
const periodLink = (page: Page, name: string) =>
	page.getByRole('navigation', { name: 'Period', exact: true }).getByRole('link', { name });
const e1rmTile = (page: Page) => page.getByTestId('exercise-e1rm');
const valueOf = async (locator: Locator) => Number(await locator.getAttribute('data-value'));

/** Serve the app's scripts, handing each request for the trends' chunk (ExerciseTrends) to `trends`. */
async function routeTrendsChunk(
	page: Page,
	trends: (route: Route, response: APIResponse) => Promise<void>
) {
	await page.route('**/_app/immutable/**/*.js', async (route) => {
		const response = await route.fetch().catch(() => null);
		if (!response) return route.abort('internetdisconnected');
		const body = await response.text();
		if (!body.includes('exercise-e1rm')) return route.fulfill({ response, body });
		await trends(route, response);
	});
}

/** Open Progress, then follow a link the router takes to the lift (nothing links there yet). */
async function navigateTo(page: Page, path: string) {
	await gotoHydrated(page, '/progress');
	await page.evaluate((href) => {
		const link = Object.assign(document.createElement('a'), { href, textContent: 'Lift' });
		link.dataset.testid = 'to-exercise';
		document.querySelector('main')!.append(link);
	}, path);
	await page.getByTestId('to-exercise').click();
	await expect(page).toHaveURL(new RegExp(`${path}$`));
}

/** The period's complete weeks: `weeks` weeks ending the Sunday before this week. */
const periodOf = (seeded: SeededAnalytics, weeks: number) => ({
	from: addDays(seeded.weekStart, -7 * weeks),
	to: addDays(seeded.weekStart, -1)
});

async function expectBestE1rm(page: Page, seeded: SeededAnalytics, key: string, weeks: number) {
	const { from, to } = periodOf(seeded, weeks);
	const best = await bestE1rmBetween(key, from, to);
	expect(best, `${key} has estimates in ${weeks} weeks`).not.toBeNull();
	expect(await valueOf(e1rmTile(page)), `best e1RM over ${weeks} weeks`).toBeCloseTo(best!, 1);
}

test.describe('twelve weeks', () => {
	let seeded: SeededAnalytics;

	test.beforeAll(async ({ request }) => {
		seeded = await seedAnalytics(request, 'twelve-weeks');
	});

	test('the best e1RM, the rep maxes and the PRs equal the oracles', async ({ page }) => {
		await gotoHydrated(page, pathOf(seeded, 'back_squat'));
		await expect(page.getByRole('heading', { level: 1, name: 'Back squat' })).toBeVisible();
		await expectBestE1rm(page, seeded, 'back_squat', 12);
		await expect(page.getByTestId('exercise-detail').getByTestId('verdict').first()).toHaveText(
			'Real improvement'
		);

		// Every rep count from 1 to 10 has a row; those lifted hold the heaviest working weight.
		const rows = page.getByTestId('rep-max');
		await expect(rows).toHaveCount(10);
		const maxes = await repMaxes('back_squat');
		expect(maxes.length).toBeGreaterThan(0);
		await expect(page.locator('[data-testid="rep-max"][data-value]')).toHaveCount(maxes.length);
		for (const { reps, weightKg } of maxes) {
			expect(await valueOf(rows.nth(reps - 1)), `${reps}-rep max`).toBeCloseTo(weightKg, 1);
		}

		// Every e1RM and session-volume PR, newest first, each with the record it beat.
		const prs = await prRows('back_squat');
		for (const kind of ['e1rm', 'volume'] as const) {
			const expected = prs.filter((pr) => pr.kind === kind).toReversed();
			const items = page.getByTestId(`pr-${kind}`);
			await expect(items).toHaveCount(expected.length);
			for (const [i, pr] of expected.entries()) {
				expect(await valueOf(items.nth(i)), `${kind} PR on ${pr.day}`).toBeCloseTo(pr.value, 1);
				await expect(items.nth(i)).toContainText('was ');
			}
		}

		// Recent sessions open their workout.
		const recent = page.getByTestId('recent-session');
		await expect(recent.first()).toHaveAttribute('href', /\/progress\/workouts\/[0-9a-f-]{36}$/);
	});

	test('the profile’s tested bench max reads as measured, apart from the estimates', async ({
		page
	}) => {
		await gotoHydrated(page, pathOf(seeded, 'bench_press'));
		const marker = page.locator('[data-testid="max-marker"][data-kind="measured"]');
		await expect(marker).toContainText('100 kg');
		await expect(marker).toContainText('Measured');
		expect(await valueOf(marker)).toBeCloseTo(100, 1);
		const chart = page.getByTestId('chart-e1rm');
		await expect(chart).toContainText('estimated 1RM');
		const twin = chart.getByTestId('chart-table');
		await expect(twin.locator('td', { hasText: '100, measured' })).toHaveCount(1);
		await expect(chart.getByTestId('line-legend')).toContainText('Measured');
		await expect(chart.locator('[data-testid="line-mark"][data-kind="measured"]')).toHaveCount(1);
	});

	test('the keyboard scrubs the chart to a week, its value the oracle’s', async ({ page }) => {
		await gotoHydrated(page, pathOf(seeded, 'back_squat'));
		const chart = page.getByTestId('chart-e1rm');
		const body = chart.getByTestId('line-chart');
		await body.focus();
		await page.keyboard.press('End');
		await page.keyboard.press('ArrowLeft');
		const tip = chart.getByTestId('line-tooltip');
		await expect(tip).toHaveAttribute('data-shown', '');
		const lastWeek = periodOf(seeded, 1);
		const best = await bestE1rmBetween('back_squat', lastWeek.from, lastWeek.to);
		const value = await tip.locator('.tip-value').first().textContent();
		expect(parseFloat(value!.replace(/,/g, ''))).toBeCloseTo(best!, 0);
		await expect(chart.getByTestId('line-live')).toContainText('estimated');
	});

	test.describe('with requests held', () => {
		// page.route sees requests from a page the service worker controls only when it is blocked.
		test.use({ serviceWorkers: 'block' });

		test('a period switch keeps the frame, dimmed and busy, then shows the period', async ({
			page
		}) => {
			await gotoHydrated(page, pathOf(seeded, 'back_squat'));
			let release!: () => void;
			const held = new Promise<void>((resolve) => (release = resolve));
			await page.route('**/__data.json*', async (route) => {
				await held;
				await route.continue();
			});
			const content = page.getByTestId('period-content');
			await expectNoShift(page, {
				boxes: [page.getByRole('navigation', { name: 'Period', exact: true }), e1rmTile(page)],
				action: async () => {
					await periodLink(page, 'Last 4 weeks').click();
					await expect(content).toHaveAttribute('aria-busy', 'true');
				}
			});
			release();
			await expect(page).toHaveURL(/period=4w$/);
			await expect(content).toHaveAttribute('aria-busy', 'false');
			await expectBestE1rm(page, seeded, 'back_squat', 4);
			await page.goBack();
			await expect(periodLink(page, 'Last 12 weeks')).toHaveAttribute('aria-current', 'page');
			await expectBestE1rm(page, seeded, 'back_squat', 12);
		});

		test('a client navigation holds the trends’ room while their code loads, and they fill it', async ({
			page
		}) => {
			let release = () => {};
			const held = new Promise<void>((resolve) => (release = resolve));
			await routeTrendsChunk(page, async (route, response) => {
				await held;
				await route.fulfill({ response });
			});
			await navigateTo(page, pathOf(seeded, 'bench_press'));
			// The verdict is there at once; the trends hold their room.
			await expect(
				page.getByTestId('exercise-detail').getByTestId('verdict').first()
			).toBeVisible();
			const reserve = page.getByTestId('exercise-trends');
			await expect(reserve).toHaveAttribute('aria-busy', 'true');
			await expect(e1rmTile(page)).toHaveCount(0);
			const room = await boxOf(reserve);
			await page.waitForFunction(() => document.fonts.status === 'loaded');

			release();
			await expectBestE1rm(page, seeded, 'bench_press', 12);
			await expect(reserve).toHaveCount(0);
			const lead = await boxOf(page.getByRole('region', { name: 'Estimated 1RM' }));
			const last = await boxOf(page.getByTestId('recent-sessions'));
			expect(Math.abs(lead.y - room.y), 'the trends start where their room did').toBeLessThan(1);
			const filled = last.y + last.height - lead.y;
			expect(Math.abs(filled - room.height), 'the trends fill their room').toBeLessThan(
				room.height * 0.05
			);
		});

		test('code that fails to load is a notice with Retry under the verdict, and Retry recovers', async ({
			page
		}) => {
			await routeTrendsChunk(page, (route) => route.abort('internetdisconnected'));
			await navigateTo(page, pathOf(seeded, 'back_squat'));
			const failed = page.getByTestId('exercise-trends-error');
			await expect(failed).toContainText('Couldn’t load this lift’s trends');
			// Only the trends failed: the header's verdict and the frame are there.
			await expect(
				page.getByTestId('exercise-detail').getByTestId('verdict').first()
			).toBeVisible();
			await expect(periodLink(page, 'Last 12 weeks')).toHaveAttribute('aria-current', 'page');
			await expect(page.getByTestId('error-view')).toHaveCount(0);

			// Where the browser keeps the failed fetch (Chromium), Retry reloads the page.
			await page.unrouteAll({ behavior: 'wait' });
			await failed.getByRole('button', { name: 'Retry' }).click();
			await expect(failed).toHaveCount(0);
			await expectBestE1rm(page, seeded, 'back_squat', 12);
		});
	});

	test('an unknown id is the 404 page in the shell', async ({ page }) => {
		const response = await page.goto(`/progress/exercises/${crypto.randomUUID()}`);
		expect(response?.status()).toBe(404);
		await expect(page.getByTestId('error-view')).toHaveAttribute('data-kind', 'not-found');
		await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
	});

	test('a failed load shows Retry inside the screen, and Retry recovers', async ({
		page,
		context
	}) => {
		await context.addCookies([{ name: 'pc-test-fail', value: 'progress-exercise', url: ORIGIN }]);
		await gotoHydrated(page, pathOf(seeded, 'back_squat'));
		const failed = page.getByTestId('exercise-failed');
		await expect(failed).toContainText('Couldn’t load this exercise');
		await expect(page.getByTestId('error-view')).toHaveCount(0);

		await context.clearCookies({ name: 'pc-test-fail' });
		await failed.getByRole('button', { name: 'Retry' }).click();
		await expect(failed).toHaveCount(0);
		await expectBestE1rm(page, seeded, 'back_squat', 12);
	});

	test('offline, a client navigation here is the designed offline state, and online loads it', async ({
		page,
		context,
		browserName
	}) => {
		test.skip(browserName !== 'chromium', 'offline emulation is Chromium-only');
		await gotoHydrated(page, '/progress');
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
			timeout: 15_000
		});
		// Nothing links here from the overview yet (exercise-trends-link): a link the router takes.
		await page.evaluate(
			(href) => {
				const link = Object.assign(document.createElement('a'), { href, textContent: 'Squat' });
				link.dataset.testid = 'to-exercise';
				document.querySelector('main')!.append(link);
			},
			pathOf(seeded, 'back_squat')
		);
		await context.setOffline(true);
		await page.getByTestId('to-exercise').click();
		await expect(page).toHaveURL(new RegExp(`${pathOf(seeded, 'back_squat')}$`));
		await expect(page.getByTestId('offline-state')).toBeVisible();
		await expect(page.locator('body')).not.toContainText(/500|internal error/i);

		await context.setOffline(false);
		await expect(page.getByTestId('offline-state')).toHaveCount(0, { timeout: 15_000 });
		await expect(page.getByRole('heading', { level: 1, name: 'Back squat' })).toBeVisible();
		await expect(e1rmTile(page)).toBeVisible();
	});

	test('axe is clean in both themes, and the phone screen is captured', async ({
		page
	}, testInfo) => {
		await page.setViewportSize({ width: 393, height: 659 });
		await gotoHydrated(page, pathOf(seeded, 'bench_press'));
		await expect(page.getByTestId('chart-e1rm').getByTestId('line-chart')).toBeVisible();
		await auditBothThemes(page, 'Exercise detail');
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'progress-exercise-phone');
	});

	test.describe('in a desktop window', () => {
		test.use({ ...DESKTOP });

		test('the chart sits beside the rep maxes, nothing scrolls sideways', async ({
			page
		}, testInfo) => {
			await gotoHydrated(page, pathOf(seeded, 'back_squat'));
			const chart = await boxOf(page.getByTestId('chart-e1rm'));
			const table = await boxOf(page.getByTestId('rep-maxes'));
			expect(Math.abs(chart.y - table.y), 'one row').toBeLessThan(1);
			expect(table.x).toBeGreaterThan(chart.x + chart.width);
			await expectNoSideScroll(page);
			await auditBothThemes(page, 'Exercise detail, desktop');
			await captureScreen(page, testInfo, 'progress-exercise-desktop');
		});
	});
});

test.describe('a first week', () => {
	test.afterAll(async () => {
		await resetAnalytics();
	});

	test('trends wait for two sessions with the lift', async ({ page, request }) => {
		const seeded = await seedAnalytics(request, 'first-week');
		await gotoHydrated(page, pathOf(seeded, 'back_squat'));
		await expect(page.getByTestId('exercise-waiting')).toContainText(
			'Trends appear after 2 sessions with this lift'
		);
		await expect(page.getByTestId('chart-plot')).toHaveCount(0);
		await expect(page.getByTestId('rep-max')).toHaveCount(10);
		await auditBothThemes(page, 'Exercise detail, first week');
	});
});
