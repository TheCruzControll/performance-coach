/**
 * A review to do on Today and Progress (m6 review-entry-points; Instrument v2, v2/06b): when a
 * week completes, Today's one line under the day reads 'Last week · Review ready' and opens
 * Progress → Reviews, where it is created; when a block completes, the block is Today's day
 * ('Done'), its button the review's create form, Review the block. Progress's Overview leads
 * with the prompt (ReviewPrompt), one tap from creating and opening it, then 'See your review'.
 *
 * - week-complete: Today's line, under the day, with Start still above the tab bar on a 393 × 659
 *   phone; it opens the reviews list, whose Create opens the review. Once reviewed, no line.
 *   Overview's Create states: pending (aria-busy, a second tap posts nothing: one row), a 500
 *   with Try again that recovers, offline (disabled, Chromium). On a Sunday the block's last week is
 *   done too and Today offers the block instead (block-end covers it), so these skip.
 * - block-end: Today's day is the block; Review the block creates and opens its review, and Today
 *   then leaves it to Progress, whose Overview reads 'See your review'. A 500 is the day's one
 *   red line, and its button reads Try again.
 * - A program that started this week, mid-week with sessions to come: no review on Today.
 * - Progress: the prompt at the top of Overview creates and opens the review.
 * - On a phone and in a desktop window: in the day's column, nothing scrolls sideways, axe clean
 *   in both themes, the screens captured.
 *
 * Serial: the history is the one owner's, which every browser and worker shares.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { weekdayOf } from '../src/lib/domain/calendar';
import { DESKTOP, boxOf, expectNoSideScroll } from './desktop';
import { cycleReviews, weeklyReviews } from './oracles/reviews';
import { seedProgram } from './program-support';
import {
	ANALYTICS_TZ,
	auditBothThemes,
	query,
	resetReviews,
	seedReview,
	type ReviewScenario,
	type SeededReview
} from './review-support';
import { captureScreen, gotoHydrated } from './support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

const LIST = '/progress/reviews';
const SUNDAY = 'On a Sunday the block’s last week is done too: Today offers the block instead';
const OVERVIEW = '/progress';

const weekOf = (seeded: SeededReview) =>
	seeded.review.kind === 'weekly' ? seeded.review.weekStartsOn : '';
const isSunday = (seeded: SeededReview) => weekdayOf(seeded.today) === 'sun';
const promptOf = (page: Page) => page.getByTestId('review-prompt');
const createButton = (page: Page) => promptOf(page).getByRole('button');
const day = (page: Page) => page.getByTestId('today-day');
/** Today's one line for a week to review. */
const reviewLine = (page: Page) => page.locator('[data-testid="today-line"][data-kind="review"]');
/** Today's button for a block to review: its create form's submit. */
const reviewBlock = (page: Page) => day(page).getByTestId('review-block');
/** Create's POST from a prompt: the reviews screen's own actions. */
const isCreate = (url: URL) => url.pathname === LIST && url.search === '?/create';
/** Review the block's POST from Today: the reviews screen's cycle action. */
const isCreateCycle = (url: URL) => url.pathname === LIST && url.search === '?/createCycle';
/** Today shows the plan, and so the prompt, only once onboarding is complete. */
const onboard = () => query('update athlete_profiles set onboarding_completed_at = now()');
/** Seed `scenario` (seedReview), with onboarding complete. */
async function seedOnboarded(request: APIRequestContext, scenario: ReviewScenario) {
	const seeded = await seedReview(request, scenario);
	await onboard();
	return seeded;
}

test.afterAll(async ({ request }) => {
	await resetReviews(request);
});

test.describe('week-complete, on Today', () => {
	let seeded: SeededReview;

	test.beforeAll(async ({ request }) => {
		seeded = await seedOnboarded(request, 'week-complete');
	});

	test('the week’s review is one line under the day, Start stays above the tab bar, and the line opens the list that creates it', async ({
		page
	}, testInfo) => {
		test.skip(isSunday(seeded), SUNDAY);
		// The phone's window (the iPhone 15 Pro's): with the prompt gone, Start clears the tab bar.
		await page.setViewportSize({ width: 393, height: 659 });
		await gotoHydrated(page, '/today');
		await expect(day(page)).toHaveAttribute('data-state', 'session');
		await expect(promptOf(page)).toHaveCount(0);
		const line = reviewLine(page);
		await expect(line).toHaveAccessibleName('Last week, Review ready');
		await expect(line).toContainText('Last week');
		await expect(line).toContainText('Review ready');
		await expect(line).toHaveAttribute('href', LIST);
		// Under the day, which stands at the column's foot, with its one Start.
		const [dayBox, lineBox] = [await boxOf(day(page)), await boxOf(line)];
		expect(lineBox.y).toBeGreaterThanOrEqual(dayBox.y + dayBox.height - 1);
		const start = day(page).getByTestId('start-workout');
		await expect(start).toHaveText('Start');
		const startBox = await boxOf(start);
		const tabBar = await boxOf(page.getByRole('navigation', { name: 'Primary' }));
		expect(startBox.y + startBox.height, 'Start ends at or above the tab bar').toBeLessThanOrEqual(
			tabBar.y
		);
		await expectNoSideScroll(page);
		await auditBothThemes(page, 'Today, a week to review');
		await captureScreen(page, testInfo, 'review-entry-today-phone');

		// The line opens the reviews list, whose row creates the week's review and opens it.
		await line.click();
		await expect(page).toHaveURL(new RegExp(`${LIST}$`));
		const create = page.locator(
			`[data-testid="review-create"]:has(input[name="weekStartsOn"][value="${weekOf(seeded)}"])`
		);
		await create.getByRole('button').click();
		await expect(page).toHaveURL(new RegExp(`${LIST}/w-${weekOf(seeded)}$`));
		expect(await weeklyReviews(weekOf(seeded))).toHaveLength(1);

		// Reviewed: nothing on Today; Progress → Reviews lists it.
		await gotoHydrated(page, '/today');
		await expect(day(page)).toHaveAttribute('data-state', 'session');
		await expect(reviewLine(page)).toHaveCount(0);
		await expect(promptOf(page)).toHaveCount(0);
	});

	test.describe('in a desktop window', () => {
		test.use({ ...DESKTOP });

		test('the line sits in the day’s column, under it, with nothing beside it', async ({
			page,
			request
		}, testInfo) => {
			// The phone's test above wrote the review: start again from none.
			seeded = await seedOnboarded(request, 'week-complete');
			test.skip(isSunday(seeded), SUNDAY);
			await gotoHydrated(page, '/today');
			const line = reviewLine(page);
			await expect(line).toBeVisible();
			const [dayBox, lineBox] = [await boxOf(day(page)), await boxOf(line)];
			expect(Math.abs(lineBox.x - dayBox.x), 'the day’s column').toBeLessThan(2);
			expect(lineBox.width, 'within the 560 px column').toBeLessThanOrEqual(561);
			expect(lineBox.y).toBeGreaterThanOrEqual(dayBox.y + dayBox.height - 1);
			// The goals and This week left Today's side column (v2/06a): nothing sits beside it.
			await expect(page.getByTestId('today-side')).toHaveCount(0);
			await expect(promptOf(page)).toHaveCount(0);
			await line.hover();
			await expectNoSideScroll(page);
			await auditBothThemes(page, 'Today, a week to review, desktop');
			await captureScreen(page, testInfo, 'review-entry-today-desktop');
		});
	});

	test('offline: Overview’s Create is disabled, with You’re offline', async ({
		page,
		context,
		browserName,
		request
	}) => {
		test.skip(browserName !== 'chromium', 'offline emulation is Chromium-only');
		seeded = await seedOnboarded(request, 'week-complete');
		test.skip(isSunday(seeded), SUNDAY);
		await gotoHydrated(page, OVERVIEW);
		// Going offline while the service worker installs would fail its install: let it take
		// control first.
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
			timeout: 15_000
		});
		await expect(createButton(page)).toBeEnabled();
		await context.setOffline(true);
		await expect(createButton(page)).toBeDisabled();
		await expect(promptOf(page).getByTestId('create-offline')).toHaveText('You’re offline');
		await context.setOffline(false);
		await expect(createButton(page)).toBeEnabled();
		expect(await weeklyReviews(weekOf(seeded))).toHaveLength(0);
	});

	test.describe('with requests held', () => {
		// page.route sees requests from a page the service worker controls only when it is blocked.
		test.use({ serviceWorkers: 'block' });

		test('a 500 shows Try again inside Overview’s card, and Try again resends and opens the review', async ({
			page
		}) => {
			test.skip(isSunday(seeded), SUNDAY);
			const week = weekOf(seeded);
			await gotoHydrated(page, OVERVIEW);
			await page.route(isCreate, (route) =>
				route.fulfill({ status: 500, contentType: 'application/json', body: '{"type":"error"}' })
			);
			await createButton(page).click();
			await expect(promptOf(page).getByTestId('create-failed')).toContainText(
				'Couldn’t create this review'
			);
			await expect(createButton(page)).toHaveText('Try again');
			await expect(page.getByTestId('error-view')).toHaveCount(0);
			await expect(page).toHaveURL(/\/progress$/);
			expect(await weeklyReviews(week)).toHaveLength(0);

			await page.unrouteAll({ behavior: 'wait' });
			await createButton(page).click();
			await expect(page).toHaveURL(new RegExp(`${LIST}/w-${week}$`));
			expect(await weeklyReviews(week)).toHaveLength(1);
		});

		test('Overview’s Create is busy while it posts, a second tap posts nothing, it opens the review, and Overview then reads See your review', async ({
			page,
			request
		}) => {
			// The Try again test above wrote the review: start again from none.
			seeded = await seedOnboarded(request, 'week-complete');
			test.skip(isSunday(seeded), SUNDAY);
			const week = weekOf(seeded);
			await gotoHydrated(page, OVERVIEW);
			let posts = 0;
			let release!: () => void;
			const held = new Promise<void>((resolve) => (release = resolve));
			await page.route(isCreate, async (route) => {
				posts += 1;
				await held;
				await route.continue();
			});
			const button = createButton(page);
			await button.click();
			await expect(button).toHaveAttribute('aria-busy', 'true');
			await expect(button).toBeDisabled();
			// A second tap, and a second submit of the form itself, post nothing.
			await button.dispatchEvent('click');
			await promptOf(page)
				.locator('form')
				.evaluate((form: HTMLFormElement) => form.requestSubmit());
			release();

			await expect(page).toHaveURL(new RegExp(`${LIST}/w-${week}$`));
			await expect(page.getByRole('heading', { level: 2, name: /^Week of / })).toBeVisible();
			expect(posts).toBe(1);
			const rows = await weeklyReviews(week);
			expect(rows).toHaveLength(1);
			expect(rows.filter((r) => r.live)).toHaveLength(1);

			await gotoHydrated(page, OVERVIEW);
			await expect(promptOf(page)).toHaveAttribute('data-state', 'reviewed');
			await expect(promptOf(page)).toContainText('Your week in review');
			// Reviewed: Today shows no line for it.
			await gotoHydrated(page, '/today');
			await expect(reviewLine(page)).toHaveCount(0);
			await gotoHydrated(page, OVERVIEW);
			const see = promptOf(page).getByRole('link', { name: 'See your review' });
			await see.click();
			await expect(page).toHaveURL(new RegExp(`${LIST}/w-${week}$`));
		});
	});
});

test.describe('block-end, on Today', () => {
	let seeded: SeededReview;

	test.beforeAll(async ({ request }) => {
		seeded = await seedOnboarded(request, 'block-end');
	});

	test('the block is the day: Review the block creates and opens its review, then Today leaves it to Progress', async ({
		page
	}, testInfo) => {
		const target = seeded.review;
		if (target.kind !== 'cycle') throw new Error('block-end reviews a block');
		await page.setViewportSize({ width: 393, height: 659 });
		await gotoHydrated(page, '/today');
		await expect(day(page)).toHaveAttribute('data-state', 'block-end');
		await expect(promptOf(page)).toHaveCount(0);
		await expect(page.getByTestId('today-title')).toHaveText('Done');
		// The fixture's block: Base, four weeks.
		await expect(page.getByTestId('today-when')).toHaveText('Four weeks of Base');
		await expect(page.getByTestId('today-coach')).toHaveText(
			/^Let’s look at what it built, then I’ll (set up \S.* with you|plan what comes next with you)\.$/
		);
		await expect(reviewBlock(page)).toHaveText('Review the block');
		await expect(reviewBlock(page)).toHaveAccessibleName('Review the block');
		await expect(day(page).locator('input[name="blockLineage"]')).toHaveValue(
			target.blockLineageId
		);
		await expect(day(page).getByTestId('start-workout')).toHaveCount(0);
		// Its button above the tab bar on the phone.
		const button = await boxOf(reviewBlock(page));
		const tabBar = await boxOf(page.getByRole('navigation', { name: 'Primary' }));
		expect(button.y + button.height).toBeLessThanOrEqual(tabBar.y);
		await expectNoSideScroll(page);
		await auditBothThemes(page, 'Today, a block to review');
		await captureScreen(page, testInfo, 'review-entry-today-block-phone');

		await reviewBlock(page).click();
		await expect(page).toHaveURL(new RegExp(`${LIST}/c-[0-9a-f-]{36}$`));
		const rows = await cycleReviews(target.blockLineageId);
		expect(rows.filter((r) => r.live)).toHaveLength(1);

		// Reviewed: no longer 'due', so Today's day is the plan's again, and Overview reads it.
		await gotoHydrated(page, '/today');
		await expect(day(page)).not.toHaveAttribute('data-state', 'block-end');
		await expect(reviewBlock(page)).toHaveCount(0);
		await gotoHydrated(page, OVERVIEW);
		await expect(promptOf(page)).toHaveAttribute('data-state', 'reviewed');
		await expect(promptOf(page).getByRole('link', { name: 'See your review' })).toHaveAttribute(
			'href',
			`${LIST}/c-${rows[0]!.id}`
		);
	});

	test.describe('in a desktop window', () => {
		test.use({ ...DESKTOP });

		test('the block’s day in the readable column, Review the block 260 px wide', async ({
			page,
			request
		}, testInfo) => {
			// The phone's test above wrote the review: start again from none.
			seeded = await seedOnboarded(request, 'block-end');
			await gotoHydrated(page, '/today');
			await expect(day(page)).toHaveAttribute('data-state', 'block-end');
			const [dayBox, button] = [await boxOf(day(page)), await boxOf(reviewBlock(page))];
			expect(dayBox.width).toBeLessThanOrEqual(561);
			expect(Math.abs(button.width - 260), 'Review the block, 260 px').toBeLessThanOrEqual(1);
			await reviewBlock(page).hover();
			await expectNoSideScroll(page);
			await auditBothThemes(page, 'Today, a block to review, desktop');
			await captureScreen(page, testInfo, 'review-entry-today-block-desktop');
		});
	});

	test.describe('with requests held', () => {
		// page.route sees requests from a page the service worker controls only when it is blocked.
		test.use({ serviceWorkers: 'block' });

		test('a 500 is the day’s one red line, and its button reads Try again', async ({
			page,
			request
		}) => {
			// The phone's test above wrote the review: start again from none.
			seeded = await seedOnboarded(request, 'block-end');
			const target = seeded.review;
			if (target.kind !== 'cycle') throw new Error('block-end reviews a block');
			await gotoHydrated(page, '/today');
			await expect(day(page)).toHaveAttribute('data-state', 'block-end');
			await page.route(isCreateCycle, (route) =>
				route.fulfill({ status: 500, contentType: 'application/json', body: '{"type":"error"}' })
			);
			await reviewBlock(page).click();
			const coach = page.getByTestId('today-coach');
			await expect(coach).toHaveText(
				'Couldn’t create this review. Your training is safe: try again.'
			);
			await expect(coach).toHaveAttribute('data-danger', 'true');
			await expect(coach).toHaveAttribute('role', 'status');
			await expect(reviewBlock(page)).toHaveText('Try again');
			await expect(page.getByTestId('error-view')).toHaveCount(0);
			await expect(page).toHaveURL(/\/today$/);
			const rows = await cycleReviews(target.blockLineageId);
			expect(rows.filter((r) => r.live)).toHaveLength(0);
		});
	});
});

test('mid-week, with sessions to come in a program that started this week: no review on Today', async ({
	page,
	request
}) => {
	// The review fixture writes a complete training profile; the program then replaces its own.
	await seedReview(request, 'week-complete');
	await seedProgram(request, { fixture: 'today', start: 'this_week' });
	await onboard();
	await gotoHydrated(page, '/today');
	await expect(day(page)).toHaveAttribute('data-state', 'session');
	await expect(promptOf(page)).toHaveCount(0);
	await expect(reviewLine(page)).toHaveCount(0);
	await expect(page.getByTestId('review-block')).toHaveCount(0);
});

test.describe('week-complete, on Progress', () => {
	let seeded: SeededReview;

	test.beforeAll(async ({ request }) => {
		seeded = await seedOnboarded(request, 'week-complete');
	});

	test('the prompt leads Overview, creates and opens the review, then reads See your review', async ({
		page
	}, testInfo) => {
		test.skip(isSunday(seeded), SUNDAY);
		await gotoHydrated(page, '/progress');
		const prompt = promptOf(page);
		await expect(prompt).toContainText('Your week in review is ready');
		// Overview's first item.
		const top = (await boxOf(prompt)).y;
		expect(Math.abs(top - (await boxOf(page.getByTestId('overview'))).y)).toBeLessThan(2);
		await auditBothThemes(page, 'Progress, a week to review');
		await captureScreen(page, testInfo, 'review-entry-progress-phone');

		await createButton(page).click();
		await expect(page).toHaveURL(new RegExp(`${LIST}/w-${weekOf(seeded)}$`));
		expect(await weeklyReviews(weekOf(seeded))).toHaveLength(1);

		await gotoHydrated(page, '/progress');
		await expect(promptOf(page)).toHaveAttribute('data-state', 'reviewed');
		await promptOf(page).getByRole('link', { name: 'See your review' }).click();
		await expect(page).toHaveURL(new RegExp(`${LIST}/w-${weekOf(seeded)}$`));
	});

	test.describe('in a desktop window', () => {
		test.use({ ...DESKTOP });

		test('the prompt spans Overview’s column, nothing scrolls sideways', async ({
			page
		}, testInfo) => {
			test.skip(isSunday(seeded), SUNDAY);
			await gotoHydrated(page, '/progress');
			const prompt = await boxOf(promptOf(page));
			const overview = await boxOf(page.getByTestId('overview'));
			expect(Math.abs(prompt.x - overview.x)).toBeLessThan(2);
			expect(Math.abs(prompt.width - overview.width)).toBeLessThan(2);
			await expectNoSideScroll(page);
			await auditBothThemes(page, 'Progress, a review prompt, desktop');
			await captureScreen(page, testInfo, 'review-entry-progress-desktop');
		});
	});
});
