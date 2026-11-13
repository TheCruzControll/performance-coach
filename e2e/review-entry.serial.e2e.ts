/**
 * The review prompt on Today and Progress (m6 review-entry-points, ReviewPrompt): when a week or
 * a block completes, it leads Today's plan and Progress's Overview, one tap from creating and
 * opening its review, then 'See your review'.
 *
 * - week-complete: Today's card creates and opens last week's review, then reads 'See your
 *   review'. Create's states: pending (aria-busy, a second tap posts nothing: one row), a 500
 *   with Try again that recovers, offline (disabled, Chromium). On a Sunday the block's last week is
 *   done too and Today offers the block instead (block-end covers it), so these skip.
 * - block-end: the cycle card creates and opens the block's review.
 * - A program that started this week, mid-week with sessions to come: no prompt.
 * - Progress: the prompt at the top of Overview creates and opens the review.
 * - On a phone and in a desktop window: in the plan's column, nothing scrolls sideways, axe clean
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

const weekOf = (seeded: SeededReview) =>
	seeded.review.kind === 'weekly' ? seeded.review.weekStartsOn : '';
const isSunday = (seeded: SeededReview) => weekdayOf(seeded.today) === 'sun';
const promptOf = (page: Page) => page.getByTestId('review-prompt');
const createButton = (page: Page) => promptOf(page).getByRole('button');
/** Create's POST from a prompt: the reviews screen's own actions. */
const isCreate = (url: URL) => url.pathname === LIST && url.search === '?/create';
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

	test('the week’s prompt leads the plan; axe is clean and the screen is captured', async ({
		page
	}, testInfo) => {
		test.skip(isSunday(seeded), SUNDAY);
		await page.setViewportSize({ width: 393, height: 659 });
		await gotoHydrated(page, '/today');
		const prompt = promptOf(page);
		await expect(prompt).toHaveAttribute('data-kind', 'weekly');
		await expect(prompt).toHaveAttribute('data-state', 'due');
		await expect(prompt).toContainText('Your week in review is ready');
		await expect(prompt.locator(`input[name="weekStartsOn"]`)).toHaveValue(weekOf(seeded));
		await expect(createButton(page)).toHaveText('Create review');
		// First in the plan, above the week.
		const top = (await boxOf(prompt)).y;
		expect(top).toBeLessThan((await boxOf(page.getByTestId('week-strip'))).y);
		await expectNoSideScroll(page);
		await auditBothThemes(page, 'Today, a week to review');
		await captureScreen(page, testInfo, 'review-entry-today-phone');
	});

	test.describe('in a desktop window', () => {
		test.use({ ...DESKTOP });

		test('the prompt sits in the plan’s column, beside the side column', async ({
			page
		}, testInfo) => {
			test.skip(isSunday(seeded), SUNDAY);
			await gotoHydrated(page, '/today');
			const prompt = await boxOf(promptOf(page));
			const day = await boxOf(page.getByTestId('today-day'));
			const side = await boxOf(page.getByTestId('today-side'));
			expect(Math.abs(prompt.x - day.x), 'the plan’s column').toBeLessThan(2);
			expect(Math.abs(prompt.width - day.width), 'the plan’s width').toBeLessThan(2);
			expect(side.x).toBeGreaterThan(prompt.x + prompt.width);
			await createButton(page).hover();
			await expectNoSideScroll(page);
			await auditBothThemes(page, 'Today, a week to review, desktop');
			await captureScreen(page, testInfo, 'review-entry-today-desktop');
		});
	});

	test('offline: Create is disabled, with You’re offline', async ({
		page,
		context,
		browserName
	}) => {
		test.skip(browserName !== 'chromium', 'offline emulation is Chromium-only');
		test.skip(isSunday(seeded), SUNDAY);
		await gotoHydrated(page, '/today');
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

		test('a 500 shows Try again inside the card, and Try again resends and opens the review', async ({
			page
		}) => {
			test.skip(isSunday(seeded), SUNDAY);
			const week = weekOf(seeded);
			await gotoHydrated(page, '/today');
			await page.route(isCreate, (route) =>
				route.fulfill({ status: 500, contentType: 'application/json', body: '{"type":"error"}' })
			);
			await createButton(page).click();
			await expect(promptOf(page).getByTestId('create-failed')).toContainText(
				'Couldn’t create this review'
			);
			await expect(createButton(page)).toHaveText('Try again');
			await expect(page.getByTestId('error-view')).toHaveCount(0);
			await expect(page).toHaveURL(/\/today$/);
			expect(await weeklyReviews(week)).toHaveLength(0);

			await page.unrouteAll({ behavior: 'wait' });
			await createButton(page).click();
			await expect(page).toHaveURL(new RegExp(`${LIST}/w-${week}$`));
			expect(await weeklyReviews(week)).toHaveLength(1);
		});

		test('Create is busy while it posts, a second tap posts nothing, it opens the review, and Today then reads See your review', async ({
			page,
			request
		}) => {
			// The Try again test above wrote the review: start again from none.
			seeded = await seedOnboarded(request, 'week-complete');
			test.skip(isSunday(seeded), SUNDAY);
			const week = weekOf(seeded);
			await gotoHydrated(page, '/today');
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

			await gotoHydrated(page, '/today');
			await expect(promptOf(page)).toHaveAttribute('data-state', 'reviewed');
			await expect(promptOf(page)).toContainText('Your week in review');
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

	test('the cycle card creates and opens the block’s review, then reads See your review', async ({
		page
	}) => {
		const target = seeded.review;
		if (target.kind !== 'cycle') throw new Error('block-end reviews a block');
		await gotoHydrated(page, '/today');
		const prompt = promptOf(page);
		await expect(prompt).toHaveAttribute('data-kind', 'cycle');
		await expect(prompt).toContainText('Block complete — review it and plan the next');
		await expect(prompt.locator('input[name="blockLineage"]')).toHaveValue(target.blockLineageId);
		await auditBothThemes(page, 'Today, a block to review');

		await createButton(page).click();
		await expect(page).toHaveURL(new RegExp(`${LIST}/c-[0-9a-f-]{36}$`));
		const rows = await cycleReviews(target.blockLineageId);
		expect(rows.filter((r) => r.live)).toHaveLength(1);

		await gotoHydrated(page, '/today');
		await expect(promptOf(page)).toHaveAttribute('data-state', 'reviewed');
		await expect(promptOf(page).getByRole('link', { name: 'See your review' })).toHaveAttribute(
			'href',
			`${LIST}/c-${rows[0]!.id}`
		);
	});
});

test('mid-week, with sessions to come in a program that started this week: no prompt', async ({
	page,
	request
}) => {
	// The review fixture writes a complete training profile; the program then replaces its own.
	await seedReview(request, 'week-complete');
	await seedProgram(request, { fixture: 'today', start: 'this_week' });
	await onboard();
	await gotoHydrated(page, '/today');
	await expect(page.getByTestId('today-session').first()).toBeVisible();
	await expect(promptOf(page)).toHaveCount(0);
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
