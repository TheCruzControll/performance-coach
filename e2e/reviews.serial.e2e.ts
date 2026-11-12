/**
 * Progress → Reviews (src/routes/(app)/progress/reviews/[[key]]): on week-complete, Create opens
 * the week's review, whose planned against completed, adherence and trend words equal the SQL
 * oracle and the stored snapshot, with or without JavaScript. Create's states: pending (aria-busy,
 * a second tap posts nothing: one row), not reviewable yet (week-almost-complete, with the date),
 * a 500 with Retry that recovers, and offline (disabled). The empty list, a bad key (404), a
 * failed load with Retry, the designed offline state, the desktop split, axe in both themes and
 * the screens at 393 × 659 and 1440 × 900.
 *
 * Serial: the history is the one owner's, which every browser and worker shares.
 */
import { expect, test, type Page } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import { shortDate } from '../src/lib/ui/program/words';
import { DESKTOP, boxOf, expectNoSideScroll } from './desktop';
import { adherence } from './oracles/general';
import { weeklyReviews } from './oracles/reviews';
import {
	ANALYTICS_TZ,
	auditBothThemes,
	query,
	resetReviews,
	seedReview,
	type SeededReview
} from './review-support';
import { captureScreen, gotoHydrated, ORIGIN } from './support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

const LIST = '/progress/reviews';
const NOT_REVIEWABLE =
	'Your review is ready after Sunday, or once every session is done or skipped';

const weekOf = (seeded: SeededReview) =>
	seeded.review.kind === 'weekly' ? seeded.review.weekStartsOn : '';
const createFor = (page: Page, week: string) =>
	page.locator(`[data-testid="review-create"]:has(input[value="${week}"])`);
const createButton = (page: Page, week: string) => createFor(page, week).getByRole('button');
/** Create's POST, from the list (?/create). */
const isCreate = (url: URL) => url.pathname === LIST && url.search === '?/create';

interface StoredFinding {
	id: string;
	section: string;
	metricId: string | null;
	verdict: { words: string };
}

/** The live review's stored summary and snapshot (adherence and findings), read in SQL. */
async function storedReview(week: string) {
	const [row] = await query<{
		summary: string;
		snapshot: { adherence: { pct: number | null }; brief: { findings: StoredFinding[] } };
	}>(
		`select summary, snapshot from weekly_reviews
		where week_starts_on = $1::date and superseded_at is null`,
		[week]
	);
	return row!;
}

/** Planned against completed and adherence on the screen equal the oracle and the snapshot. */
async function expectFigures(page: Page, seeded: SeededReview) {
	const week = weekOf(seeded);
	const [oracle] = await adherence(week, addDays(week, 6), seeded.today);
	const stored = await storedReview(week);
	expect(oracle, 'the week plans sessions').toBeDefined();
	await expect(page.getByTestId('review-summary')).toHaveText(stored.summary);
	for (const [label, value] of [
		['planned', oracle!.planned],
		['completed', oracle!.completed],
		['skipped', oracle!.skipped],
		['missed', oracle!.missed]
	] as const) {
		await expect(page.getByTestId(`review-count-${label}`), label).toHaveAttribute(
			'data-value',
			String(value)
		);
	}
	const pct = Number(await page.getByTestId('review-adherence').getAttribute('data-value'));
	expect(pct, 'adherence: the oracle').toBeCloseTo(oracle!.pct!, 1);
	expect(pct, 'adherence: the snapshot').toBeCloseTo(stored.snapshot.adherence.pct!, 1);

	// Every trend the review stored, in its words.
	const trends = stored.snapshot.brief.findings.filter(
		(f) => f.section === 'verdicts' && f.metricId !== null
	);
	expect(trends.length, 'the hard week has trends').toBeGreaterThan(0);
	await expect(page.getByTestId('review-trend')).toHaveCount(trends.length);
	for (const trend of trends) {
		const item = page.locator(`[data-testid="review-trend"][data-id="${trend.id}"]`);
		await expect(item.getByTestId('trend-words')).toContainText(trend.verdict.words);
		await expect(item.getByTestId('verdict')).toBeVisible();
	}
}

test.describe('week-complete', () => {
	let seeded: SeededReview;

	test.beforeAll(async ({ request }) => {
		seeded = await seedReview(request, 'week-complete');
	});

	test('no review yet: the designed empty list, the week to review, and a bad key is a 404', async ({
		page
	}) => {
		await gotoHydrated(page, LIST);
		await expect(page.getByTestId('reviews-empty')).toContainText('No reviews yet');
		await expect(page.getByTestId('review-row')).toHaveCount(0);
		await expect(createButton(page, weekOf(seeded))).toHaveText('Create review');
		await expect(page.getByTestId('reviews-failed')).toHaveCount(0);

		for (const key of ['w-not-a-week', `w-${addDays(weekOf(seeded), 1)}`, 'x-1']) {
			const response = await page.goto(`${LIST}/${key}`);
			expect(response?.status(), key).toBe(404);
			await expect(page.getByTestId('error-view')).toHaveAttribute('data-kind', 'not-found');
		}
	});

	test.describe('with requests held', () => {
		// page.route sees requests from a page the service worker controls only when it is blocked.
		test.use({ serviceWorkers: 'block' });

		test('Create is busy while it posts, a second tap posts nothing, and it opens the review', async ({
			page
		}) => {
			const week = weekOf(seeded);
			await gotoHydrated(page, LIST);
			let posts = 0;
			let release!: () => void;
			const held = new Promise<void>((resolve) => (release = resolve));
			await page.route(isCreate, async (route) => {
				posts += 1;
				await held;
				await route.continue();
			});
			const button = createButton(page, week);
			await button.click();
			await expect(button).toHaveAttribute('aria-busy', 'true');
			await expect(button).toBeDisabled();
			// A second tap, and a second submit of the form itself, post nothing.
			await button.dispatchEvent('click');
			await createFor(page, week).evaluate((form: HTMLFormElement) => form.requestSubmit());
			release();

			await expect(page).toHaveURL(new RegExp(`${LIST}/w-${week}$`));
			await expect(page.getByRole('heading', { level: 2, name: /^Week of / })).toBeVisible();
			expect(posts).toBe(1);
			const rows = await weeklyReviews(week);
			expect(rows.filter((r) => r.live)).toHaveLength(1);
			expect(rows).toHaveLength(1);
			// The list now holds it, shown beside (or above) the review.
			await expect(page.getByTestId('review-row').first()).toBeAttached();
		});
	});

	test('the review’s planned against completed, adherence and trends equal the oracle and the snapshot', async ({
		page
	}) => {
		await gotoHydrated(page, `${LIST}/w-${weekOf(seeded)}`);
		await expectFigures(page, seeded);
		await expect(page.getByTestId('review-write-up')).toBeAttached();
	});

	test.describe('without JavaScript', () => {
		test.use({ javaScriptEnabled: false });

		test('the server renders the summary, the figures and the verdict words', async ({ page }) => {
			await page.goto(`${LIST}/w-${weekOf(seeded)}`);
			await expectFigures(page, seeded);
		});
	});

	test('a failed load shows Retry inside the screen, and Retry recovers', async ({
		page,
		context
	}) => {
		await context.addCookies([{ name: 'pc-test-fail', value: 'reviews', url: ORIGIN }]);
		await gotoHydrated(page, LIST);
		const failed = page.getByTestId('reviews-failed');
		await expect(failed).toContainText('Couldn’t load your reviews');
		await expect(page.getByTestId('error-view')).toHaveCount(0);

		await context.clearCookies({ name: 'pc-test-fail' });
		await failed.getByRole('button', { name: 'Try again' }).click();
		await expect(failed).toHaveCount(0);
		await expect(page.getByTestId('review-row')).toHaveCount(1);
	});

	test('offline: Create is disabled, and a client navigation here is the designed offline state', async ({
		page,
		context,
		browserName
	}) => {
		test.skip(browserName !== 'chromium', 'offline emulation is Chromium-only');
		await gotoHydrated(page, LIST);
		// Going offline while the service worker installs would fail its install, and no worker
		// would control /progress below: let it take control first.
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
			timeout: 15_000
		});
		const create = page.getByTestId('review-create').first();
		await expect(create).toBeVisible();
		await context.setOffline(true);
		await expect(create.getByRole('button')).toBeDisabled();
		await expect(create.getByTestId('create-offline')).toHaveText('You’re offline');
		await context.setOffline(false);
		await expect(create.getByRole('button')).toBeEnabled();

		await gotoHydrated(page, '/progress');
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
			timeout: 15_000
		});
		await context.setOffline(true);
		await page.getByTestId('reviews-row').click();
		await expect(page).toHaveURL(new RegExp(`${LIST}$`));
		await expect(page.getByTestId('offline-state')).toBeVisible();
		await expect(page.locator('body')).not.toContainText(/500|internal error/i);
		await context.setOffline(false);
	});

	test('on a phone: the review alone, back to the list; axe is clean and the screen is captured', async ({
		page
	}, testInfo) => {
		await page.setViewportSize({ width: 393, height: 659 });
		await gotoHydrated(page, `${LIST}/w-${weekOf(seeded)}`);
		await expect(page.getByTestId('weekly-review')).toBeVisible();
		await expect(page.getByTestId('review-row')).toBeHidden();
		await expectNoSideScroll(page);
		await auditBothThemes(page, 'Weekly review');
		await captureScreen(page, testInfo, 'reviews-phone');

		await page.getByTestId('back-to-reviews').click();
		await expect(page).toHaveURL(new RegExp(`${LIST}$`));
		await expect(page.getByTestId('review-row')).toBeVisible();
		await auditBothThemes(page, 'Reviews list');
	});

	test.describe('in a desktop window', () => {
		test.use({ ...DESKTOP });

		test('the list beside the review, nothing scrolls sideways', async ({ page }, testInfo) => {
			await gotoHydrated(page, `${LIST}/w-${weekOf(seeded)}`);
			const list = await boxOf(page.getByRole('region', { name: 'Reviews' }));
			const review = await boxOf(page.getByTestId('weekly-review'));
			expect(Math.abs(list.y - review.y), 'one row').toBeLessThan(2);
			expect(review.x).toBeGreaterThan(list.x + list.width);
			await expect(page.getByTestId('review-row').first()).toHaveAttribute('aria-current', 'page');
			await expectNoSideScroll(page);
			await auditBothThemes(page, 'Weekly review, desktop');
			await captureScreen(page, testInfo, 'reviews-desktop');
		});
	});
});

test.describe('a create that fails', () => {
	let seeded: SeededReview;

	test.beforeAll(async ({ request }) => {
		seeded = await seedReview(request, 'week-complete');
	});

	// page.route sees requests from a page the service worker controls only when it is blocked.
	test.use({ serviceWorkers: 'block' });

	test('a 500 shows Retry, and Retry resends and opens the review', async ({ page }) => {
		const week = weekOf(seeded);
		await gotoHydrated(page, LIST);
		await page.route(isCreate, (route) =>
			route.fulfill({ status: 500, contentType: 'application/json', body: '{"type":"error"}' })
		);
		await createButton(page, week).click();
		await expect(createFor(page, week).getByTestId('create-failed')).toContainText(
			'Couldn’t create this review'
		);
		await expect(createButton(page, week)).toHaveText('Try again');
		await expect(page.getByTestId('error-view')).toHaveCount(0);
		expect(await weeklyReviews(week)).toHaveLength(0);

		await page.unrouteAll({ behavior: 'wait' });
		await createButton(page, week).click();
		await expect(page).toHaveURL(new RegExp(`${LIST}/w-${week}$`));
		expect(await weeklyReviews(week)).toHaveLength(1);
	});
});

test.describe('week-almost-complete', () => {
	let seeded: SeededReview;

	test.beforeAll(async ({ request }) => {
		seeded = await seedReview(request, 'week-almost-complete');
	});

	test.afterAll(async ({ request }) => {
		await resetReviews(request);
	});

	test('this week is not reviewable yet: Create says when it will be, and nothing is written', async ({
		page
	}) => {
		const thisWeek = seeded.weekStart;
		await gotoHydrated(page, LIST);
		const row = createFor(page, thisWeek);
		await expect(row).toHaveAttribute('data-state', 'in_progress');
		await createButton(page, thisWeek).click();
		await expect(row.getByTestId('create-refused')).toHaveText(
			`${NOT_REVIEWABLE} · Ready ${shortDate(addDays(thisWeek, 7))}`
		);
		await expect(page).toHaveURL(new RegExp(`${LIST}$`));
		expect(await weeklyReviews(thisWeek)).toHaveLength(0);
	});
});
