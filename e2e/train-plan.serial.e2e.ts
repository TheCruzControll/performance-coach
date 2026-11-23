/**
 * The whole plan (src/routes/(app)/train/plan, Instrument v2 Paper 4 · Train "The whole plan"):
 * See the whole plan, a link in Train's More sheet, opens a page of its own with the program's
 * title, its length and last day, and one line per phase with its weeks, the done ones ticked and
 * the current one named. No phase is a link, an outline's included. Its back link is "Week", and
 * End this plan, at the foot, asks first: Keep my plan gives the focus back, End the plan archives
 * the plan and lands on Today. With no program the page is Train. A readable screen on a desktop.
 * Serial: the program is the one owner's (e2e/program-support.ts).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import { longDate } from '../src/lib/ui/program/words';
import { DESKTOP, expectMainCentred, expectNoSideScroll, tokenPx } from './desktop';
import { openMore, PROGRAM_TZ, seedProgram, type SeededProgram } from './program-support';
import {
	captureScreen,
	gotoHydrated,
	query,
	resetTrainingProfile,
	trackConsoleErrors
} from './support';

test.use({ timezoneId: PROGRAM_TZ });

test.beforeEach(async () => {
	await resetTrainingProfile();
});

async function audit(page: Page): Promise<string[]> {
	await page.evaluate(() => document.fonts.ready);
	await page.waitForTimeout(500); // entrance transitions settle: contrast on final colours
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) =>
		v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
	);
}

const phases = (page: Page) => page.getByTestId('plan-phases').getByRole('listitem');
const endPlan = (page: Page) => page.getByTestId('end-plan');
const ask = (page: Page) => page.getByRole('dialog', { name: 'End this plan' });

test.describe('a program this week', () => {
	let seeded: SeededProgram;
	test.beforeEach(async ({ request }) => {
		seeded = await seedProgram(request, { fixture: 'hybrid', start: 'this_week' });
	});

	test('More’s See the whole plan opens the plan: one line per phase, the current one named', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await gotoHydrated(page, '/train');
		await openMore(page);
		await page.getByTestId('open-plan').click();
		await expect(page).toHaveURL(/\/train\/plan$/);
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('The plan');
		// The hybrid fixture: a baseline week, then four weeks of accumulation, ending on the
		// Sunday of week 5.
		await expect(page.getByTestId('plan-span')).toHaveText(
			`Strength, running and Muay Thai · 5 weeks, ending ${longDate(addDays(seeded.weekStart, 34))}`
		);
		await expect(phases(page)).toHaveCount(2);
		await expect(phases(page).nth(0)).toHaveAttribute('data-state', 'now');
		await expect(phases(page).nth(0)).toContainText('Baseline week, now');
		await expect(phases(page).nth(0)).toContainText('Week 1');
		await expect(phases(page).nth(1)).toHaveAttribute('data-state', 'ahead');
		await expect(phases(page).nth(1)).toContainText('Accumulation');
		await expect(phases(page).nth(1)).toContainText('Weeks 2 to 5');
		// The current phase in 600; none is a link.
		expect(
			await phases(page)
				.nth(0)
				.locator('.name')
				.evaluate((el) => getComputedStyle(el).fontWeight)
		).toBe('600');
		await expect(page.getByTestId('plan-phases').getByRole('link')).toHaveCount(0);
		await captureScreen(page, testInfo, 'train-plan');

		// Its back link names the week, and goes back to it.
		const back = page.getByTestId('back-to-train');
		await expect(back).toHaveText('Week');
		await back.click();
		await expect(page).toHaveURL(/\/train$/);
		await expect(page.getByTestId('week-lines')).toBeVisible();
		expect(errors).toEqual([]);
	});

	test('an old ?tool=plan opens nothing on Train', async ({ page }) => {
		await gotoHydrated(page, '/train?tool=plan');
		await expect(page.getByTestId('week-lines')).toBeVisible();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page).toHaveURL(/\/train\?tool=plan$/);
	});

	test('the page and End this plan’s question pass axe in dark and light', async ({ page }) => {
		await gotoHydrated(page, '/train/plan');
		for (const theme of ['dark', 'light'] as const) {
			await page.evaluate(
				(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
				theme
			);
			await gotoHydrated(page, '/train/plan');
			if (theme === 'light')
				await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
			expect(await audit(page), `axe, the plan, ${theme}`).toEqual([]);
			await endPlan(page).click();
			await expect(ask(page)).toBeVisible();
			expect(await audit(page), `axe, End this plan, ${theme}`).toEqual([]);
		}
	});

	test.describe('on a desktop window', () => {
		test.use(DESKTOP);

		test('the plan stands in the readable column; End this plan has its hover and focus states', async ({
			page
		}, testInfo) => {
			await gotoHydrated(page, '/train/plan');
			await expectMainCentred(page, await tokenPx(page, '--content-readable'));
			await expectNoSideScroll(page);
			const colour = () => endPlan(page).evaluate((el) => getComputedStyle(el).color);
			const rest = await colour();
			await endPlan(page).hover();
			await expect.poll(colour, { message: 'a hover state' }).not.toBe(rest);
			await page.mouse.move(720, 880);

			await endPlan(page).focus();
			await page.keyboard.press('Enter');
			await expect(ask(page)).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(ask(page)).toBeHidden();
			await expect(endPlan(page)).toBeFocused();
			await captureScreen(page, testInfo, 'train-plan-desktop');
		});
	});

	test('End this plan asks first, then archives it and lands on Build my program', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await gotoHydrated(page, '/train/plan');
		// From the keyboard: WebKit focuses no button on a click, so the focus would have nowhere
		// to come back to.
		await endPlan(page).focus();
		await page.keyboard.press('Enter');
		await expect(ask(page)).toBeVisible();
		await expect(ask(page)).toContainText('Your logged workouts stay.');
		await captureScreen(page, testInfo, 'train-plan-end');

		// Keep my plan closes the question, the focus back on End this plan, and nothing changed.
		await ask(page).getByTestId('end-plan-keep').click();
		await expect(ask(page)).toBeHidden();
		await expect(endPlan(page)).toBeFocused();
		await expect(phases(page)).toHaveCount(2);

		await endPlan(page).click();
		await ask(page).getByTestId('end-plan-confirm-button').click();
		await expect(page).toHaveURL(/\/today$/);
		// No plan on Today: the next one is built from there (the fixture's owner has not finished
		// onboarding, so Today asks for that first; a set-up owner sees Build my program).
		await expect(page.getByTestId('today-setup').or(page.getByTestId('today-build'))).toBeVisible();
		await expect(page.getByTestId('today-plan')).toHaveCount(0);
		const [row] = await query<{ status: string }>('select status from programs where id = $1', [
			seeded.programId
		]);
		expect(row?.status).toBe('archived');
		expect(errors).toEqual([]);
	});
});

test('an outline phase reads its weeks like any other, and never links', async ({
	page,
	request
}, testInfo) => {
	const seeded = await seedProgram(request, { fixture: 'one-week', start: 'this_week' });
	await gotoHydrated(page, '/train/plan');
	await expect(page.getByTestId('plan-span')).toContainText(
		`4 weeks, ending ${longDate(addDays(seeded.weekStart, 27))}`
	);
	// Only week 1 is planned; the outline's three weeks follow it.
	await expect(phases(page)).toHaveCount(2);
	await expect(phases(page).nth(0)).toContainText('Baseline week, now');
	await expect(phases(page).nth(1)).toContainText('Accumulation');
	await expect(phases(page).nth(1)).toContainText('Weeks 2 to 4');
	await expect(phases(page).nth(1)).toHaveAttribute('data-state', 'ahead');
	await expect(page.getByTestId('plan-phases').getByRole('link')).toHaveCount(0);
	await captureScreen(page, testInfo, 'train-plan-outline');
	expect(await audit(page)).toEqual([]);
});

test('with no program, the plan is Train, which says what comes first', async ({ page }) => {
	await gotoHydrated(page, '/train/plan');
	await expect(page).toHaveURL(/\/train$/);
	await expect(page.getByTestId('train-empty')).toBeVisible();
});
