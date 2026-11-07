/**
 * Today until onboarding is complete: a setup card with how many of the steps that apply are
 * done and Continue to the step to resume at, which is how the owner gets into onboarding after
 * first sign-in and back into it after a reload. The card streams in and fails soft: a read that
 * fails is a designed error with Retry, never a 500. Once it is complete, Today summarises the
 * open goals by rank (weeks to go counted from the device's date) and the shape of the week, with
 * the commitments marked on the week strip. Serial (one test at a time, after the
 * functional suites): every test starts from a blank training profile, which every browser and
 * worker shares, and the last one leaves it blank again.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { DESKTOP, expectMainCentred, expectNoSideScroll, tokenPx } from './desktop';
import {
	captureScreen,
	gotoHydrated,
	profileAction,
	query,
	resetTrainingProfile,
	SAME_ORIGIN,
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

/** The device's date `days` from now, as a stored calendar date (the browser shares its zone). */
function inDays(days: number): string {
	const d = new Date();
	d.setDate(d.getDate() + days);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A fight ten weeks out (ranked first), a marathon three weeks out, and a strength goal. */
const FIGHT = {
	kind: 'event',
	title: 'First Muay Thai fight',
	disciplines: ['muay_thai'],
	eventType: 'Muay Thai fight',
	eventDate: inDays(70)
};
const MARATHON = {
	kind: 'event',
	title: 'Valencia marathon',
	disciplines: ['distance_running', 'custom'],
	customDiscipline: 'Hill repeats',
	eventType: 'Marathon',
	eventDate: inDays(24)
};
const STRENGTH = {
	kind: 'general',
	title: 'Keep my strength',
	disciplines: ['strength'],
	focus: 'Hold squat and deadlift',
	measure: 'Top sets at RPE 8 stay within 5%'
};

/** Onboarding finished through the app's own actions: goals, schedule, then Finish on review. */
async function setUp(request: APIRequestContext) {
	for (const goal of [FIGHT, MARATHON, STRENGTH]) {
		await profileAction(request, '/profile/goals?/saveGoal', goal);
	}
	await profileAction(request, '/profile/schedule?/save', {
		daysPerWeek: 4,
		availableDays: ['mon', 'tue', 'thu', 'sat'],
		preferredTimes: [],
		sessionMinutes: 60,
		commitments: [
			{
				discipline: 'muay_thai',
				label: 'Muay Thai class',
				days: ['tue', 'thu'],
				timeOfDay: 'evening',
				durationMinutes: 90,
				intensity: 'hard'
			}
		]
	});
	const finish = await request.post('/onboarding/review?/complete', {
		headers: { ...SAME_ORIGIN, accept: 'application/json', 'x-sveltekit-action': 'true' },
		multipart: { payload: '{}' }
	});
	expect(await finish.json()).toMatchObject({ type: 'redirect', location: '/today' });
}

const goals = (page: Page) => page.getByTestId('today-goal');

async function audit(page: Page) {
	await page.waitForFunction(() => document.fonts.status === 'loaded');
	await page.waitForTimeout(400);
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
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

test('once set up, Today lists the goals by rank with weeks to go, and the shape of the week', async ({
	page,
	request
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	await setUp(request);
	await gotoHydrated(page, '/today');
	await expect(card(page)).toHaveCount(0);

	await expect(goals(page)).toHaveCount(3);
	await expect(goals(page).getByRole('heading', { level: 3 })).toHaveText([
		'First Muay Thai fight',
		'Valencia marathon',
		'Keep my strength'
	]);
	await expect(goals(page).nth(0)).toContainText('Top priority');
	await expect(page.getByText('Top priority')).toHaveCount(1);
	await expect(goals(page).nth(0).getByRole('listitem')).toHaveText(['Muay Thai']);
	await expect(goals(page).nth(1).getByRole('listitem')).toHaveText([
		'Half / marathon',
		'Hill repeats'
	]);
	// Counted from the device's date once hydrated; a goal with no date has no countdown.
	await expect(goals(page).nth(0).getByTestId('today-goal-countdown')).toHaveText('10 weeks to go');
	await expect(goals(page).nth(1).getByTestId('today-goal-countdown')).toHaveText('3 weeks to go');
	await expect(goals(page).nth(2).getByTestId('today-goal-countdown')).toHaveCount(0);

	const schedule = page.getByTestId('today-schedule');
	await expect(page.getByTestId('today-schedule-summary')).toHaveText(
		'4 days a week · 60 min sessions'
	);
	await expect(schedule).toContainText('Free to train Mon, Tue, Thu, Sat');
	await expect(page.getByTestId('today-commitment')).toHaveText(
		/Muay Thai class\s*Tue, Thu · evening · 90 min · hard/
	);
	// The class is marked on Tuesday and Thursday of the week strip, and named for screen readers.
	const days = page.getByRole('list', { name: 'This week' }).locator('> li');
	await expect(days).toHaveCount(7);
	for (const [i, booked] of [false, true, false, true, false, false, false].entries()) {
		await expect(days.nth(i).getByTestId('today-day-booked')).toHaveCount(booked ? 1 : 0);
		if (booked) await expect(days.nth(i)).toContainText('Muay Thai class');
		else await expect(days.nth(i)).not.toContainText('Muay Thai class');
	}

	expect(await audit(page), 'dark').toEqual([]);
	await captureScreen(page, testInfo, 'today-ready');
	await page.evaluate(() =>
		localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: 'light' }))
	);
	await gotoHydrated(page, '/today');
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
	await expect(goals(page)).toHaveCount(3);
	expect(await audit(page), 'light').toEqual([]);
	expect(errors).toEqual([]);
});

test('once set up, the goals and schedule stream in below what is already painted', async ({
	page,
	request
}) => {
	await setUp(request);
	// What lies between the first card and the plate row: in the server-rendered page, before the
	// stream resolves, and again once it has. Streamed sections may only add below them.
	await page.addInitScript(() => {
		const gap = () => {
			const first = document.querySelector('main .stack > *')!.getBoundingClientRect();
			const plate = document.querySelector('a[href*="tool=plates"]')!.getBoundingClientRect();
			return plate.top - first.bottom;
		};
		document.addEventListener('DOMContentLoaded', () =>
			Object.assign(window, {
				__painted: {
					gap: gap(),
					streaming: !!document.querySelector('[data-testid="today-setup-loading"]')
				}
			})
		);
		Object.assign(window, { __gap: gap });
	});
	await gotoHydrated(page, '/today');
	await expect(goals(page)).toHaveCount(3);
	type Measured = { __painted: { gap: number; streaming: boolean }; __gap: () => number };
	const painted = await page.evaluate(() => (window as unknown as Measured).__painted);
	expect(painted.streaming, 'measured before the stream resolved').toBe(true);
	const now = await page.evaluate(() => (window as unknown as Measured).__gap());
	expect(Math.abs(now - painted.gap), 'nothing streams in above the plate row').toBeLessThanOrEqual(
		1
	);
	const plate = (await page.getByRole('link', { name: /Plate calculator/ }).boundingBox())!;
	const goalsTop = (await page.getByTestId('today-goals').boundingBox())!.y;
	expect(goalsTop).toBeGreaterThan(plate.y + plate.height);
});

test('reordering goals in Profile changes the order on Today', async ({ page, request }) => {
	await setUp(request);
	await gotoHydrated(page, '/profile/goals');
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
	await page.getByRole('button', { name: 'Move Valencia marathon up', exact: true }).click();
	await expect(page.getByTestId('goal-order-status')).toHaveText(
		'Valencia marathon is now priority 1 of 3'
	);
	await expect
		.poll(() => query<{ title: string }>('select title from training_goals order by priority'))
		.toEqual([
			{ title: 'Valencia marathon' },
			{ title: 'First Muay Thai fight' },
			{ title: 'Keep my strength' }
		]);

	await page.getByRole('link', { name: 'Today' }).first().click();
	await expect(page).toHaveURL('/today');
	await expect(goals(page).getByRole('heading', { level: 3 })).toHaveText([
		'Valencia marathon',
		'First Muay Thai fight',
		'Keep my strength'
	]);
	await expect(goals(page).nth(0)).toContainText('Top priority');
	await expect(goals(page).nth(1)).not.toContainText('Top priority');
});

test('with no open goal left, Today says so and links to Goals', async ({ page, request }) => {
	await setUp(request);
	await query(`update training_goals set status = 'achieved', priority = null, closed_at = now()`);
	await gotoHydrated(page, '/today');
	const empty = page.getByTestId('today-goals-empty');
	await expect(empty).toContainText('No open goals');
	await expect(goals(page)).toHaveCount(0);
	await expect(empty.getByRole('link', { name: 'Add a goal' })).toHaveAttribute(
		'href',
		'/profile/goals'
	);
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

	test('once set up, goals and schedule sit in the readable column, and Edit has a hover state', async ({
		page,
		request
	}, testInfo) => {
		await setUp(request);
		await gotoHydrated(page, '/today');
		await expect(goals(page)).toHaveCount(3);
		await expectMainCentred(page, await tokenPx(page, '--content-readable'));
		await expectNoSideScroll(page);
		const main = (await page.locator('main#main').boundingBox())!;
		for (const id of ['today-goals', 'today-schedule']) {
			const box = (await page.getByTestId(id).boundingBox())!;
			expect(box.x).toBeGreaterThanOrEqual(main.x - 1);
			expect(box.x + box.width).toBeLessThanOrEqual(main.x + main.width + 1);
		}
		const edit = page
			.getByTestId('today-goals')
			.getByRole('link', { name: 'Edit goals', exact: true });
		const background = () => edit.evaluate((el) => getComputedStyle(el).backgroundColor);
		const resting = await background();
		await edit.hover();
		await expect.poll(background).not.toBe(resting);
		await captureScreen(page, testInfo, 'today-ready-desktop');
	});
});
