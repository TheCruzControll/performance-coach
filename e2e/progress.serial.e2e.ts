/**
 * Progress → Overview (src/routes/(app)/progress): 'am I improving?' at a glance, server-rendered
 * from the overview service. On the twelve-weeks history its numbers equal the SQL oracles
 * (e2e/oracles/overview.ts) through data-value, with and without JavaScript; the week so far is
 * shown apart; verdicts say their window; period links switch and Back restores; a refetch holds
 * the frame; offline switches and failed loads have designed states; a new owner and a first week
 * are told what appears and when; the profile's units win over the device's; desktop lays the
 * tiles in one row; axe is clean in both themes. The trends (tiles, charts, timeline) load after
 * the verdicts: a client navigation holds their room, and code that fails to load offers Retry.
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
import { addDays, weekdayOf } from '../src/lib/domain/calendar';
import { WEEKDAY_INFO } from '../src/lib/domain/profile/catalog';
import {
	ANALYTICS_TZ,
	auditBothThemes,
	resetAnalytics,
	seedAnalytics,
	type SeededAnalytics
} from './analytics-support';
import { DESKTOP, boxOf, expectNoShift, expectNoSideScroll } from './desktop';
import { figuresBetween, type OverviewFigures } from './oracles/overview';
import { e1rmChange } from './oracles/strength';
import { captureScreen, gotoHydrated, ORIGIN } from './support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

const KPIS = ['tonnage', 'mileage', 'sessions', 'adherence', 'srpe_load'] as const;

const tile = (page: Page, id: (typeof KPIS)[number]) => page.getByTestId(`kpi-${id}`);
const periodLink = (page: Page, name: string) =>
	page.getByRole('navigation', { name: 'Period', exact: true }).getByRole('link', { name });
const content = (page: Page) => page.getByTestId('period-content');
const valueOf = async (locator: Locator) => Number(await locator.getAttribute('data-value'));

/** Serve the app's scripts, handing each request for the trends' chunk (OverviewTrends) to `trends`. */
async function routeTrendsChunk(
	page: Page,
	trends: (route: Route, response: APIResponse) => Promise<void>
) {
	await page.route('**/_app/immutable/**/*.js', async (route) => {
		const response = await route.fetch().catch(() => null);
		if (!response) return route.abort('internetdisconnected');
		const body = await response.text();
		if (!body.includes('overview-kpis')) return route.fulfill({ response, body });
		await trends(route, response);
	});
}

/** The period's complete weeks: `weeks` weeks ending the Sunday before this week. */
const periodOf = (seeded: SeededAnalytics, weeks: number) => ({
	from: addDays(seeded.weekStart, -7 * weeks),
	to: addDays(seeded.weekStart, -1),
	weeks
});

/** Every KPI tile's data-value equals the oracle over the period's complete weeks. */
async function expectKpis(page: Page, seeded: SeededAnalytics, weeks: number) {
	const { from, to } = periodOf(seeded, weeks);
	const o = await figuresBetween(from, to, seeded.today);
	expect(await valueOf(tile(page, 'tonnage')), `tonnage over ${weeks} weeks`).toBeCloseTo(
		o.tonnageKg,
		1
	);
	expect(await valueOf(tile(page, 'mileage')), 'mileage: the mean week').toBeCloseTo(
		o.metres / weeks,
		0
	);
	expect(await valueOf(tile(page, 'sessions')), 'sessions').toBe(o.sessions);
	expect(await valueOf(tile(page, 'srpe_load')), 'session-RPE load').toBeCloseTo(o.loadAu, 0);
	expect(await valueOf(tile(page, 'adherence')), 'adherence').toBeCloseTo(o.adherencePct!, 1);
	return o;
}

/** '6,200 kg', or what a tile says for nothing. */
const kg = (value: number) =>
	value === 0
		? /(0 kg|nothing)/
		: `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })} kg`;

test.describe('twelve weeks', () => {
	let seeded: SeededAnalytics;

	test.beforeAll(async ({ request }) => {
		seeded = await seedAnalytics(request, 'twelve-weeks');
	});

	test('the KPI tiles equal the oracles, the week so far set against the same days of last week', async ({
		page
	}) => {
		await gotoHydrated(page, '/progress');
		await expect(page.getByTestId('overview')).toHaveAttribute('data-stage', 'history');
		await expectKpis(page, seeded, 12);

		// This week so far (Monday to today) against Monday to the same weekday last week.
		const thisWeek = await figuresBetween(seeded.weekStart, seeded.today, seeded.today);
		const lastWeek: OverviewFigures = await figuresBetween(
			addDays(seeded.weekStart, -7),
			addDays(seeded.today, -7),
			seeded.today
		);
		const soFar = tile(page, 'tonnage').getByTestId('so-far');
		const day = WEEKDAY_INFO[weekdayOf(seeded.today)].label;
		await expect(soFar).toContainText('This week so far:');
		await expect(soFar).toContainText(kg(thisWeek.tonnageKg));
		await expect(soFar).toContainText(`by ${day} last week`);
		if (lastWeek.tonnageKg > 0) await expect(soFar).toContainText(kg(lastWeek.tonnageKg));
	});

	test('each verdict says its words and its window, at 12 weeks and at 4', async ({ page }) => {
		await gotoHydrated(page, '/progress');
		const strength = page.locator('[data-testid="verdict-card"][data-area="strength"]');
		await expect(strength).toContainText('Trend over the last 12 weeks');
		await expect(
			strength.getByRole('listitem').filter({ hasText: 'Back squat' }).getByTestId('verdict')
		).toHaveText('Real improvement');
		await expect(tile(page, 'mileage').getByTestId('verdict')).toHaveText('Real improvement');

		await gotoHydrated(page, '/progress?period=4w');
		await expect(tile(page, 'mileage').getByTestId('verdict')).toHaveText(
			'Real improvement over the last 12 weeks'
		);
		await expect(strength).toContainText('Trend over the last 12 weeks');
		await expect(page.getByTestId('overview-context')).toContainText(
			'Last 4 weeks · Compared with the 4 weeks before · Trend over the last 12 weeks'
		);
	});

	test('a period link updates the numbers and the URL, and Back restores them', async ({
		page
	}) => {
		await gotoHydrated(page, '/progress');
		await periodLink(page, 'Last 4 weeks').click();
		await expect(page).toHaveURL(/\/progress\?period=4w$/);
		await expect(periodLink(page, 'Last 4 weeks')).toHaveAttribute('aria-current', 'page');
		await expect(content(page)).toHaveAttribute('aria-busy', 'false');
		await expectKpis(page, seeded, 4);

		await page.goBack();
		await expect(page).toHaveURL(/\/progress$/);
		await expect(periodLink(page, 'Last 12 weeks')).toHaveAttribute('aria-current', 'page');
		await expect(content(page)).toHaveAttribute('aria-busy', 'false');
		await expectKpis(page, seeded, 12);
	});

	test.describe('with requests held', () => {
		// page.route sees requests from a page the service worker controls only when it is blocked.
		test.use({ serviceWorkers: 'block' });

		test('a refetch holds the frame, dimmed and busy, and nothing shifts', async ({ page }) => {
			await gotoHydrated(page, '/progress');
			let release!: () => void;
			const held = new Promise<void>((resolve) => (release = resolve));
			await page.route('**/__data.json*', async (route) => {
				await held;
				await route.continue();
			});
			await expectNoShift(page, {
				boxes: [
					page.getByRole('navigation', { name: 'Period', exact: true }),
					page.getByTestId('overview-kpis'),
					tile(page, 'tonnage')
				],
				action: async () => {
					await periodLink(page, 'Last 26 weeks').click();
					await expect(content(page)).toHaveAttribute('aria-busy', 'true');
				}
			});
			release();
			await expect(page).toHaveURL(/period=26w$/);
			await expect(content(page)).toHaveAttribute('aria-busy', 'false');
			await expectKpis(page, seeded, 26);
		});
	});

	test.describe('the trends load after the verdicts', () => {
		// page.route sees requests from a page the service worker controls only when it is blocked.
		test.use({ serviceWorkers: 'block' });

		// Chunks may still be in flight when a test ends (WebKit loads more after Retry): unroute
		// first, so a handler whose response is disposed with the page cannot fail a passed test.
		test.afterEach(async ({ page }) => {
			await page.unrouteAll({ behavior: 'ignoreErrors' });
		});

		test('a client navigation holds their room while their code loads, and they fill it', async ({
			page
		}) => {
			let release = () => {};
			const held = new Promise<void>((resolve) => (release = resolve));
			await routeTrendsChunk(page, async (route, response) => {
				await held;
				await route.fulfill({ response });
			});
			await gotoHydrated(page, '/progress/workouts');
			await page.getByRole('link', { name: 'Progress' }).first().click();
			await expect(page).toHaveURL(/\/progress$/);
			// The verdicts are there at once; the trends hold their room.
			await expect(page.getByTestId('verdict-card').first()).toBeVisible();
			const reserve = page.getByTestId('overview-trends');
			await expect(reserve).toHaveAttribute('aria-busy', 'true');
			await expect(tile(page, 'tonnage')).toHaveCount(0);
			const room = await boxOf(reserve);
			await page.waitForFunction(() => document.fonts.status === 'loaded');

			release();
			await expectKpis(page, seeded, 12);
			await expect(reserve).toHaveCount(0);
			const kpis = await boxOf(page.getByTestId('overview-kpis'));
			const trends = await boxOf(page.getByRole('region', { name: 'Trends' }));
			expect(Math.abs(kpis.y - room.y), 'the trends start where their room did').toBeLessThan(1);
			const filled = trends.y + trends.height - kpis.y;
			expect(Math.abs(filled - room.height), 'the trends fill their room').toBeLessThan(
				room.height * 0.05
			);
		});

		test('code that fails to load is a notice with Retry under the verdicts, and Retry recovers', async ({
			page
		}) => {
			// One handler for the whole test, so each request is handled once: unrouting here while
			// other chunks are in flight lets Playwright continue them under a running handler.
			let failing = true;
			await routeTrendsChunk(page, (route, response) =>
				failing ? route.abort('internetdisconnected') : route.fulfill({ response })
			);
			await gotoHydrated(page, '/progress/workouts');
			await page.getByRole('link', { name: 'Progress' }).first().click();
			const failed = page.getByTestId('overview-trends-error');
			await expect(failed).toContainText('Couldn’t load your trends');
			// Only the trends failed: the verdicts and the frame are there.
			await expect(page.getByTestId('verdict-card').first()).toBeVisible();
			await expect(periodLink(page, 'Last 12 weeks')).toHaveAttribute('aria-current', 'page');
			await expect(page.getByTestId('error-view')).toHaveCount(0);

			// Where the browser keeps the failed fetch (Chromium), Retry reloads Progress.
			failing = false;
			await failed.getByRole('button', { name: 'Retry' }).click();
			await expect(failed).toHaveCount(0);
			await expectKpis(page, seeded, 12);
		});
	});

	test('offline, a period tap is cancelled: the notice shows, the URL and numbers stay', async ({
		page,
		context,
		browserName
	}) => {
		test.skip(browserName !== 'chromium', 'offline emulation is Chromium-only');
		await gotoHydrated(page, '/progress');
		const before = await valueOf(tile(page, 'tonnage'));
		await context.setOffline(true);
		await periodLink(page, 'Last 4 weeks').click();
		await expect(page.getByTestId('progress-offline')).toHaveText(
			'You’re offline — showing 12 weeks'
		);
		await expect(page).toHaveURL(/\/progress$/);
		expect(await valueOf(tile(page, 'tonnage'))).toBe(before);
		await expect(periodLink(page, 'Last 12 weeks')).toHaveAttribute('aria-current', 'page');
		await context.setOffline(false);
		await expect(page.getByTestId('progress-offline')).toHaveCount(0);
	});

	test('a failed load shows Retry inside the screen, and Retry recovers', async ({
		page,
		context
	}) => {
		await context.addCookies([{ name: 'pc-test-fail', value: 'progress', url: ORIGIN }]);
		await gotoHydrated(page, '/progress');
		const failed = page.getByTestId('progress-failed');
		await expect(failed).toContainText('Couldn’t load your progress');
		await expect(page.getByRole('heading', { level: 1, name: 'Progress' })).toBeVisible();
		await expect(page.getByTestId('error-view')).toHaveCount(0);

		await context.clearCookies({ name: 'pc-test-fail' });
		await failed.getByRole('button', { name: 'Retry' }).click();
		await expect(failed).toHaveCount(0);
		await expect(page.getByTestId('overview')).toHaveAttribute('data-stage', 'history');
		await expectKpis(page, seeded, 12);
	});

	test('the profile’s units win: the device set to lb, the profile in kg, Progress shows kg', async ({
		page
	}) => {
		await page.addInitScript(() =>
			localStorage.setItem('pc:prefs:v1', '{"theme":"dark","units":"lb","distance":"mi"}')
		);
		await gotoHydrated(page, '/progress');
		await expect(tile(page, 'tonnage')).toContainText(' kg');
		await expect(tile(page, 'tonnage')).not.toContainText(' lb');
		await expect(tile(page, 'mileage')).toContainText(' km');
		await expect(tile(page, 'mileage')).not.toContainText(' mi');
	});

	test('the server links the view’s stylesheet, render-blocking', async ({ page }) => {
		const response = await page.request.get('/progress');
		expect(response.ok()).toBe(true);
		const html = await response.text();
		const hrefs = [...html.matchAll(/<link\b[^>]*>/g)]
			.map(([tag]) => tag)
			.filter((tag) => /\brel="stylesheet"/.test(tag))
			.map((tag) => /\bhref="([^"]+)"/.exec(tag)![1]!);
		const sheets: string[] = [];
		for (const href of hrefs) {
			const sheet = await page.request.get(new URL(href, `${ORIGIN}/progress`).pathname);
			sheets.push(await sheet.text());
		}
		expect(sheets.some((css) => css.includes('pc-overview-view'))).toBe(true);
		expect(html).toContain('pc-overview-view');
	});

	test('axe is clean in both themes, and the phone screen is captured', async ({
		page
	}, testInfo) => {
		await page.setViewportSize({ width: 393, height: 659 });
		await gotoHydrated(page, '/progress');
		await auditBothThemes(page, 'Progress overview');
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'progress-overview-phone');
	});

	test.describe('in a desktop window', () => {
		test.use({ ...DESKTOP });

		test('the five tiles share one row, nothing scrolls sideways', async ({ page }, testInfo) => {
			await gotoHydrated(page, '/progress');
			const boxes = [];
			for (const id of KPIS) boxes.push(await boxOf(tile(page, id)));
			for (const [i, box] of boxes.entries()) {
				expect(Math.abs(box.y - boxes[0]!.y), `${KPIS[i]} is in the first row`).toBeLessThan(1);
				if (i > 0) expect(box.x).toBeGreaterThan(boxes[i - 1]!.x + boxes[i - 1]!.width);
			}
			const cards = await page.getByTestId('verdict-card').all();
			const [first, second] = [await boxOf(cards[0]!), await boxOf(cards[1]!)];
			expect(Math.abs(first.y - second.y), 'the cards pair up').toBeLessThan(1);
			await expectNoSideScroll(page);
			await auditBothThemes(page, 'Progress overview, desktop');
			await captureScreen(page, testInfo, 'progress-overview-desktop');
		});
	});

	test.describe('without JavaScript', () => {
		test.use({ javaScriptEnabled: false });

		test('the server renders the numbers, verdicts and table twins, and period links navigate', async ({
			page
		}) => {
			await page.goto('/progress?period=4w');
			await expectKpis(page, seeded, 4);
			await expect(tile(page, 'mileage').getByTestId('verdict')).toHaveText(
				'Real improvement over the last 12 weeks'
			);

			// Each frame's table twin holds its values: 4 complete weeks and this one, so far.
			const load = page.getByTestId('chart-load');
			const rows = load.getByTestId('chart-table').locator('tbody tr');
			await expect(rows).toHaveCount(5);
			await expect(rows.last()).toHaveAttribute('data-in-progress', 'true');
			const lastWeek = periodOf(seeded, 1);
			const { loadAu } = await figuresBetween(lastWeek.from, lastWeek.to, seeded.today);
			const total = await rows.nth(3).locator('td').last().textContent();
			expect(Number(total!.replace(/,/g, ''))).toBeCloseTo(loadAu, 0);
			await expect(load.getByTestId('chart-no-js')).toHaveText('Chart needs JavaScript');
			for (const lift of await page.getByTestId('chart-lift').all()) {
				await expect(lift.getByTestId('chart-table').locator('tbody tr')).toHaveCount(5);
			}
			// The squat's last complete week is that week's one session's best e1RM (kg profile).
			const squat = page
				.getByTestId('chart-lift')
				.filter({ has: page.getByRole('heading', { name: /squat · estimated 1RM/i }) });
			const best = await e1rmChange('back_squat', lastWeek.from, lastWeek.to);
			const cell = await squat.getByTestId('chart-table').locator('tbody tr').nth(3).locator('td');
			expect(parseFloat((await cell.textContent())!.replace(/,/g, ''))).toBeCloseTo(best!.last, 0);

			await periodLink(page, 'Last 12 weeks').click();
			await expect(page).toHaveURL(/\/progress\?period=12w$/);
			await expectKpis(page, seeded, 12);
		});
	});
});

test.describe('a new owner', () => {
	test.afterAll(async () => {
		await resetAnalytics();
	});

	test('with nothing logged: what appears and when, and no ghost chart', async ({
		page,
		request
	}) => {
		await seedAnalytics(request, 'new-user');
		await gotoHydrated(page, '/progress');
		await expect(page.getByTestId('overview')).toHaveAttribute('data-stage', 'new');
		await expect(
			page.getByRole('heading', { name: 'Your progress starts with your first session' })
		).toBeVisible();
		const timeline = page.getByTestId('overview-timeline');
		await expect(timeline.getByRole('listitem')).toHaveCount(6);
		await expect(timeline).toContainText('Personal records');
		await expect(page.getByTestId('chart-plot')).toHaveCount(0);
		await expect(page.locator('svg.ghost-chart')).toHaveCount(0);
		await auditBothThemes(page, 'Progress, new owner');
	});

	test('in the first week: the week so far, and when totals and trends arrive', async ({
		page,
		request
	}) => {
		const seeded = await seedAnalytics(request, 'first-week');
		await gotoHydrated(page, '/progress');
		const timeline = page.getByTestId('overview-timeline');
		await expect(timeline).toContainText('Trend verdicts');
		await expect(page.getByTestId('chart-plot')).toHaveCount(0);
		// On a Monday nothing is logged yet (the fixture logs up to yesterday): still a new owner.
		if (seeded.today === seeded.weekStart) {
			await expect(page.getByTestId('overview')).toHaveAttribute('data-stage', 'new');
			return;
		}
		await expect(page.getByTestId('overview')).toHaveAttribute('data-stage', 'first_week');
		await expect(page.getByRole('heading', { name: 'Your first week is under way' })).toBeVisible();
		await expect(tile(page, 'sessions').getByTestId('so-far')).toContainText('This week so far:');
	});
});
