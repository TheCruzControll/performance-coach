/**
 * Today until onboarding is complete: a setup card with how many of the steps that apply are
 * done and Continue to the step to resume at, which is how the owner gets into onboarding after
 * first sign-in and back into it after a reload. The card is server-rendered and fails soft: a
 * read that fails is a designed error with Retry, never a 500. Serial (one test at a time, after the
 * functional suites): every test starts from a blank training profile, which every browser and
 * worker shares, and the last one leaves it blank again.
 */
import { expect, test, type Page } from '@playwright/test';
import { DESKTOP, expectMainCentred, expectNoSideScroll, tokenPx } from './desktop';
import {
	captureScreen,
	gotoHydrated,
	query,
	resetTrainingProfile,
	trackConsoleErrors
} from './support';

const card = (page: Page) => page.getByTestId('today-setup');
const count = (page: Page) => page.getByTestId('today-setup-count');
const cta = (page: Page) => page.getByTestId('today-setup-continue');

/** The onboarding step's editor has loaded in place of its skeleton. */
async function stepReady(page: Page, step: string) {
	await expect(page.locator(`.step[data-step="${step}"]`)).toBeVisible();
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
}

async function continueTo(page: Page, step: string) {
	await page.getByTestId('step-continue').click();
	await expect(page).toHaveURL(`/onboarding/${step}`);
	await stepReady(page, step);
}

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test.afterAll(async () => {
	await resetTrainingProfile();
});

test('from a blank profile Today starts setup, and after two steps resumes where it stopped, across a reload', async ({
	page
}, testInfo) => {
	test.setTimeout(90_000);
	const errors = trackConsoleErrors(page);
	await gotoHydrated(page, '/today');
	await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
	await expect(card(page).getByRole('heading', { level: 2 })).toHaveText(
		'Set up your training profile'
	);
	// No goal yet, so no running or Muay Thai specifics: 10 steps, review included.
	await expect(count(page)).toHaveText('0 of 10 steps done');
	await expect(cta(page)).toHaveText('Start setup');
	await expect(page.getByTestId('today-session')).toHaveCount(0);
	await captureScreen(page, testInfo, 'today-setup');

	await cta(page).click();
	await expect(page).toHaveURL('/onboarding');
	await stepReady(page, 'welcome');
	await page.getByRole('textbox', { name: 'What should your coach call you?' }).fill('Niko');
	await page
		.getByRole('radiogroup', { name: 'Weights in' })
		.getByRole('radio', { name: 'kg' })
		.check();
	await page
		.getByRole('radiogroup', { name: 'Distances in' })
		.getByRole('radio', { name: 'km' })
		.check();
	await continueTo(page, 'goals');

	await page.getByTestId('goal-path-event').click();
	const sheet = page.getByTestId('goal-sheet');
	await sheet.getByRole('textbox', { name: 'Goal', exact: true }).fill('First Muay Thai fight');
	await sheet.getByRole('checkbox', { name: 'Muay Thai' }).check();
	await sheet.getByRole('button', { name: 'Muay Thai fight', exact: true }).click();
	await sheet.getByLabel('Event date').fill('2027-03-14');
	await sheet.getByRole('button', { name: 'Save goal' }).click();
	await expect(sheet).toBeHidden();
	await continueTo(page, 'experience');

	// Finish later: Today now picks up from Experience, and counts the fight's specifics step.
	await page.getByTestId('finish-later').click();
	await expect(page).toHaveURL('/today');
	const resumed = async () => {
		await expect(card(page).getByRole('heading', { level: 2 })).toHaveText(
			'Finish setting up your profile'
		);
		await expect(count(page)).toHaveText('2 of 11 steps done');
		await expect(cta(page)).toHaveText('Continue: Experience');
		await expect(cta(page)).toHaveAttribute('href', '/onboarding/experience');
	};
	await resumed();
	await page.reload();
	await resumed();
	await captureScreen(page, testInfo, 'today-setup-resume');

	// Continue lands on Experience with nothing lost: the fight's discipline is there to rate.
	await cta(page).click();
	await expect(page).toHaveURL('/onboarding/experience');
	await stepReady(page, 'experience');
	await expect(page.getByTestId('experience-entry')).toHaveCount(1);
	await expect(page.getByTestId('experience-entry')).toContainText('Muay Thai');
	expect(
		await query(
			`select p.name, p.weight_unit, p.onboarding_completed, g.title
			   from athlete_profiles p join training_goals g using (owner_id)`
		)
	).toEqual([
		{
			name: 'Niko',
			weight_unit: 'kg',
			onboarding_completed: ['welcome', 'goals'],
			title: 'First Muay Thai fight'
		}
	]);
	expect(errors).toEqual([]);
});

test('once onboarding is complete, Today has no setup card', async ({ page }) => {
	await gotoHydrated(page, '/today');
	await expect(card(page)).toBeVisible();
	await query('update athlete_profiles set onboarding_completed_at = now()');
	await gotoHydrated(page, '/today');
	const session = page.getByTestId('today-session');
	await expect(session.getByRole('heading', { level: 2 })).toHaveText('Nothing scheduled yet');
	await expect(page.getByTestId('today-next-step')).toContainText('Training profile');
	await expect(page.getByTestId('today-next-step')).toContainText('Ready');
	await expect(card(page)).toHaveCount(0);
});

test('a setup read that fails is a designed error with Retry inside the shell, and Retry recovers', async ({
	page
}, testInfo) => {
	await gotoHydrated(page, '/today');
	await expect(card(page)).toBeVisible();
	const before = await query<{ n: number }>(
		`select count(*)::int as n from app_errors where context->>'load' = 'todaySetup'`
	);
	// The table the read needs is out of reach while the screen loads (renamed, then restored).
	await query('alter table athlete_profiles rename to athlete_profiles_away');
	try {
		await page.reload();
		const failed = page.getByTestId('today-setup-error');
		await expect(failed).toContainText('Couldn’t load your setup');
		await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
		await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
		await expect(page.locator('body')).not.toContainText(/500|internal error/i);
		await expect(card(page)).toHaveCount(0);
		const retry = failed.getByRole('button', { name: 'Retry' });
		const target = (await retry.boundingBox())!;
		expect(target.height).toBeGreaterThanOrEqual(44);
		await captureScreen(page, testInfo, 'today-setup-error');
		expect(
			await query<{ n: number }>(
				`select count(*)::int as n from app_errors where context->>'load' = 'todaySetup'`
			)
		).toEqual([{ n: before[0]!.n + 1 }]);
	} finally {
		await query('alter table athlete_profiles_away rename to athlete_profiles');
	}
	await page.getByTestId('today-setup-error').getByRole('button', { name: 'Retry' }).click();
	await expect(count(page)).toHaveText('0 of 10 steps done');
	await expect(page.getByTestId('today-setup-error')).toHaveCount(0);
});

test.describe('in a desktop window', () => {
	test.use(DESKTOP);

	test('the setup card sits in the readable column, and its Continue has a hover state', async ({
		page
	}, testInfo) => {
		await gotoHydrated(page, '/today');
		await expect(card(page)).toBeVisible();
		await expectMainCentred(page, await tokenPx(page, '--content-readable'));
		await expectNoSideScroll(page);
		const main = (await page.locator('main#main').boundingBox())!;
		const box = (await card(page).boundingBox())!;
		expect(box.x).toBeGreaterThanOrEqual(main.x - 1);
		expect(box.x + box.width).toBeLessThanOrEqual(main.x + main.width + 1);
		const background = () => cta(page).evaluate((el) => getComputedStyle(el).backgroundColor);
		const resting = await background();
		await cta(page).hover();
		await expect.poll(background).not.toBe(resting);
		await captureScreen(page, testInfo, 'today-setup-desktop');
	});
});
