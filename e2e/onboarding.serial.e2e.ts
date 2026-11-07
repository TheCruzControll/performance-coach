/**
 * Onboarding (/onboarding/[[step]]): a guided setup through the Profile editors, saved as it
 * goes, with a progress bar that marks only completed or skipped steps done, Skip on optional
 * steps only, Back and Finish later that keep a changed step without marking it done, and a
 * review of every answer whose Edit links come back to it (Back from there saves too, then
 * returns to the review). Start coaching needs a goal and a schedule, and says so on the block
 * that is missing one. A return visit picks up at the furthest step advanced, from /onboarding
 * and from Profile. Serial (one test at a time, after the functional suites): every test starts
 * from a blank training profile, which every browser and worker shares, and the last one leaves
 * it blank again, so later suites find onboarding open.
 */
import AxeBuilder from '@axe-core/playwright';
import { devices, expect, test, type Page } from '@playwright/test';
import { DESKTOP, expectCentredOver, expectNoSideScroll, layoutWidth, tokenPx } from './desktop';
import {
	captureScreen,
	gotoHydrated,
	profileAction,
	query,
	resetTrainingProfile,
	SAME_ORIGIN,
	toastWith,
	trackConsoleErrors
} from './support';

/** The step's editor has loaded in place of its skeleton: Continue and Skip work from here. */
async function stepReady(page: Page, step: string) {
	await expect(page.locator(`.step[data-step="${step}"]`)).toBeVisible();
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
}

const progress = (page: Page) => page.getByRole('progressbar', { name: 'Setup progress' });
const segments = (page: Page) => page.getByTestId('step-progress').locator('.segment');
const doneSteps = (page: Page) =>
	page
		.getByTestId('step-progress')
		.locator('.segment[data-done="true"]')
		.evaluateAll((els) => els.map((el) => el.getAttribute('data-step')));
const next = (page: Page) => page.getByTestId('step-continue');
const ahead = (page: Page) => page.getByRole('list', { name: 'What we’ll ask' });
const skip = (page: Page) => page.getByTestId('step-skip');

/** Continue (or Skip) and land on the next step, ready. */
async function moveOn(page: Page, button: 'continue' | 'skip', to: string) {
	await (button === 'continue' ? next(page) : skip(page)).click();
	await expect(page).toHaveURL(to === 'welcome' ? '/onboarding' : `/onboarding/${to}`);
	await stepReady(page, to);
}

async function audit(page: Page) {
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
}

/** Add an event goal through the goals step's sheet. */
async function addGoal(
	page: Page,
	goal: { title: string; discipline: string; event: string; date: string }
) {
	const sheet = page.getByTestId('goal-sheet');
	await expect(sheet.getByRole('heading', { name: 'New goal' })).toBeVisible();
	await sheet.getByRole('textbox', { name: 'Goal', exact: true }).fill(goal.title);
	await sheet.getByRole('checkbox', { name: goal.discipline }).check();
	await sheet.getByRole('button', { name: goal.event, exact: true }).click();
	await sheet.getByLabel('Event date').fill(goal.date);
	await sheet.getByRole('button', { name: 'Save goal' }).click();
	await expect(sheet).toBeHidden();
}

/** The review's blocks, in order, by step. */
const blocks = (page: Page) =>
	page
		.locator('section[data-testid^="summary-"]')
		.evaluateAll((els) =>
			els.map((el) => el.getAttribute('data-testid')!.slice('summary-'.length))
		);
const block = (page: Page, step: string) => page.getByTestId(`summary-${step}`);
const schedule = { daysPerWeek: 3, availableDays: [], preferredTimes: [], commitments: [] };

const strengthGoal = {
	kind: 'general',
	title: 'Get stronger',
	disciplines: ['strength'],
	focus: 'Squat and deadlift',
	measure: 'Top sets at RPE 8 go up'
};

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test.afterAll(async () => {
	await resetTrainingProfile();
});

test('a fight and a marathon, every 1RM blank: set up step by step, stored, and Today after', async ({
	page
}, testInfo) => {
	test.setTimeout(120_000);
	const errors = trackConsoleErrors(page);
	await gotoHydrated(page, '/onboarding');
	await stepReady(page, 'welcome');
	await expect(page.getByRole('heading', { level: 1 })).toHaveText(
		'Let’s build your plan around you'
	);
	// A first visit says what is ahead; there is nothing to pick up yet.
	await expect(ahead(page).getByRole('listitem')).toContainText([
		'Goals & priorities',
		'Experience & strength',
		'Your week'
	]);
	await expect(ahead(page).getByRole('listitem')).toHaveCount(3);
	await expect(page.getByTestId('resume-card')).toHaveCount(0);
	await expect(skip(page)).toHaveCount(0);
	await captureScreen(page, testInfo, 'onboarding-welcome');
	await page.getByRole('textbox', { name: 'What should your coach call you?' }).fill('Niko');
	await page
		.getByRole('radiogroup', { name: 'Weights in' })
		.getByRole('radio', { name: 'kg' })
		.check();
	await page
		.getByRole('radiogroup', { name: 'Distances in' })
		.getByRole('radio', { name: 'km' })
		.check();
	await moveOn(page, 'continue', 'goals');

	await expect(skip(page)).toHaveCount(0);
	await captureScreen(page, testInfo, 'onboarding-goals');
	await page.getByTestId('goal-path-event').click();
	await addGoal(page, {
		title: 'First Muay Thai fight',
		discipline: 'Muay Thai',
		event: 'Muay Thai fight',
		date: '2027-03-14'
	});
	await page.getByTestId('add-goal').click();
	await addGoal(page, {
		title: 'Valencia marathon',
		discipline: 'Half / marathon',
		event: 'Marathon',
		date: '2027-12-05'
	});
	await expect(page.getByTestId('goal-row')).toHaveCount(2);
	await moveOn(page, 'continue', 'experience');

	await expect(skip(page)).toHaveCount(0);
	const entries = page.getByTestId('experience-entry');
	await expect(entries).toHaveCount(2);
	for (const entry of await entries.all()) {
		await entry.getByRole('radio', { name: 'Novice', exact: true }).check();
	}
	await captureScreen(page, testInfo, 'onboarding-experience');
	await moveOn(page, 'continue', 'strength');

	await page.getByRole('switch', { name: 'I don’t know my 1RMs' }).check();
	await captureScreen(page, testInfo, 'onboarding-strength');
	await moveOn(page, 'continue', 'specifics');

	// Running and Muay Thai goals bring the specifics step.
	const running = page.getByRole('region', { name: 'Running', exact: true });
	await running.getByRole('textbox', { name: 'Easy pace', exact: true }).fill('5.45');
	const muayThai = page.getByRole('region', { name: 'Muay Thai', exact: true });
	await muayThai.getByRole('textbox', { name: 'Sessions', exact: true }).fill('3');
	await captureScreen(page, testInfo, 'onboarding-specifics');
	// No empty profile has this step, so a11y.e2e.ts cannot reach it: audited here, both themes.
	expect(await audit(page)).toEqual([]);
	await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
	await page.waitForTimeout(400);
	expect(await audit(page)).toEqual([]);
	await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
	await moveOn(page, 'continue', 'equipment');

	for (const [step, to] of [
		['equipment', 'injuries'],
		['injuries', 'exercises'],
		['exercises', 'schedule']
	] as const) {
		await captureScreen(page, testInfo, `onboarding-${step}`);
		await moveOn(page, 'skip', to);
	}

	await expect(skip(page)).toHaveCount(0);
	const days = page.getByRole('spinbutton', { name: 'Training days a week' });
	await expect(days).toHaveAttribute('aria-valuenow', '4');
	await captureScreen(page, testInfo, 'onboarding-schedule');
	await moveOn(page, 'continue', 'body');
	await captureScreen(page, testInfo, 'onboarding-body');
	await moveOn(page, 'skip', 'review');

	// Every answer at a glance, one block per step that applies; what was skipped says so.
	expect(await blocks(page)).toEqual([
		'welcome',
		'goals',
		'experience',
		'strength',
		'specifics',
		'equipment',
		'injuries',
		'exercises',
		'schedule',
		'body'
	]);
	await expect(block(page, 'welcome')).toContainText('Niko');
	await expect(block(page, 'welcome')).toContainText('kg · km');
	await expect(block(page, 'goals').getByRole('listitem')).toHaveText([
		/^1\s*First Muay Thai fight\s*Muay Thai fight · 14 Mar 2027$/,
		/^2\s*Valencia marathon\s*Marathon · 5 Dec 2027$/
	]);
	const levels = block(page, 'experience').getByRole('listitem');
	await expect(levels).toHaveCount(2);
	await expect(levels.filter({ hasText: 'Muay Thai' })).toHaveText(/^\s*Muay Thai\s*Novice$/);
	await expect(levels.filter({ hasText: 'marathon prep' })).toHaveText(
		/^\s*Half-marathon \/ marathon prep\s*Novice$/
	);
	await expect(block(page, 'strength').getByTestId('summary-week-one')).toContainText('Week one');
	await expect(block(page, 'specifics')).toContainText('easy 5:45/km');
	await expect(block(page, 'specifics')).toContainText('3 sessions a week');
	for (const step of ['equipment', 'injuries', 'exercises', 'body']) {
		await expect(block(page, step), step).toContainText('Not told yet');
	}
	await expect(block(page, 'schedule')).toContainText('4 days a week');
	await expect(page.getByRole('alert')).toHaveCount(0);
	await captureScreen(page, testInfo, 'onboarding-review');
	expect(await audit(page)).toEqual([]);
	await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
	await page.waitForTimeout(400);
	expect(await audit(page)).toEqual([]);
	await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
	await next(page).click();
	await expect(page).toHaveURL('/today');

	await page.reload();
	await expect(page).toHaveURL('/today');
	expect(
		await query(
			`select name, weight_unit, distance_unit, baselines_unknown, onboarding_skipped,
			        onboarding_completed_at is not null as completed
			   from athlete_profiles`
		)
	).toEqual([
		{
			name: 'Niko',
			weight_unit: 'kg',
			distance_unit: 'km',
			baselines_unknown: true,
			onboarding_skipped: ['equipment', 'injuries', 'exercises', 'body'],
			completed: true
		}
	]);
	expect(await query('select count(*)::int as lifts from strength_baselines')).toEqual([
		{ lifts: 0 }
	]);
	expect(await query('select title, priority from training_goals order by priority')).toEqual([
		{ title: 'First Muay Thai fight', priority: 1 },
		{ title: 'Valencia marathon', priority: 2 }
	]);
	expect(await query('select days_per_week from schedules')).toEqual([{ days_per_week: 4 }]);
	expect(await query('select unit, easy_pace_seconds from running_profiles')).toEqual([
		{ unit: 'km', easy_pace_seconds: 345 }
	]);
	expect(await query('select sessions_per_week::float8 as n from muay_thai_profiles')).toEqual([
		{ n: 3 }
	]);

	// Finished: onboarding sends the owner to Today.
	await page.goto('/onboarding/goals');
	await expect(page).toHaveURL('/today');
	// …and Profile has nothing left to continue.
	await gotoHydrated(page, '/profile');
	await expect(page.getByTestId('section-goals')).toBeVisible();
	await expect(page.getByTestId('continue-setup')).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('stopped at schedule: a new browser context picks up there, from /onboarding and from Profile', async ({
	browser,
	context,
	page,
	request
}, testInfo) => {
	test.setTimeout(90_000);
	await profileAction(request, '/onboarding/goals?/saveGoal', strengthGoal);
	await gotoHydrated(page, '/onboarding');
	await stepReady(page, 'welcome');
	await page.getByRole('textbox', { name: 'What should your coach call you?' }).fill('Niko');
	await moveOn(page, 'continue', 'goals');
	await moveOn(page, 'continue', 'experience');
	await page
		.getByTestId('experience-entry')
		.getByRole('radio', { name: 'Novice', exact: true })
		.check();
	await moveOn(page, 'continue', 'strength');
	await moveOn(page, 'skip', 'equipment');
	await moveOn(page, 'skip', 'injuries');
	await moveOn(page, 'skip', 'exercises');
	await moveOn(page, 'skip', 'schedule');

	// The owner closes the app here; later, a new browser context with the same sign-in.
	const storageState = await context.storageState();
	await context.close();
	const { defaultBrowserType: _engine, ...phone } = devices['iPhone 15 Pro'];
	const later = await browser.newContext({ ...phone, storageState });
	try {
		const again = await later.newPage();
		const errors = trackConsoleErrors(again);
		await gotoHydrated(again, '/onboarding');
		await stepReady(again, 'welcome');
		await expect(again.getByRole('heading', { level: 1 })).toHaveText('Welcome back');
		const card = again.getByTestId('resume-card');
		await expect(card).toContainText('You stopped at Schedule');
		await expect(ahead(again)).toHaveCount(0);
		await expect(next(again)).toHaveText('Continue');
		// The answers so far are kept: the name, as the welcome's own field shows it.
		await expect(
			again.getByRole('textbox', { name: 'What should your coach call you?' })
		).toHaveValue('Niko');
		expect(await audit(again)).toEqual([]);
		await again.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
		await again.waitForTimeout(400);
		expect(await audit(again)).toEqual([]);
		await again.evaluate(() => document.documentElement.removeAttribute('data-theme'));
		await captureScreen(again, testInfo, 'onboarding-resume');

		await card.getByRole('link', { name: 'Pick up there' }).click();
		await expect(again).toHaveURL('/onboarding/schedule');
		await stepReady(again, 'schedule');
		expect(await doneSteps(again)).toEqual([
			'welcome',
			'goals',
			'experience',
			'strength',
			'equipment',
			'injuries',
			'exercises'
		]);

		// Profile's Training profile section links to the same step while setup is unfinished.
		await gotoHydrated(again, '/profile');
		const row = again.getByTestId('training-profile').getByTestId('continue-setup');
		await expect(row).toContainText('Continue setting up');
		await expect(row).toContainText('You stopped at Schedule');
		await expect(row).toHaveAttribute('href', '/onboarding/schedule');
		await row.click();
		await expect(again).toHaveURL('/onboarding/schedule');
		await stepReady(again, 'schedule');
		expect(errors).toEqual([]);
	} finally {
		await later.close();
	}
});

test('a profile never set up: Profile’s row starts at the welcome', async ({ page }) => {
	await gotoHydrated(page, '/profile');
	const row = page.getByTestId('continue-setup');
	await expect(row).toContainText('Continue setting up');
	await expect(row).toHaveAttribute('href', '/onboarding');
	await row.click();
	await expect(page).toHaveURL('/onboarding');
	await stepReady(page, 'welcome');
	await expect(page.getByTestId('resume-card')).toHaveCount(0);
	await expect(ahead(page).getByRole('listitem')).toHaveCount(3);
});

test('the progress bar marks only finished steps, and required steps have no Skip', async ({
	page
}) => {
	await gotoHydrated(page, '/onboarding/strength');
	await stepReady(page, 'strength');
	// No goal yet: no running or Muay Thai, so no specifics step.
	await expect(segments(page)).toHaveCount(10);
	await expect(progress(page)).toHaveAttribute('aria-valuenow', '4');
	await expect(progress(page)).toHaveAttribute(
		'aria-valuetext',
		'Step 4 of 10: Strength baselines'
	);
	// Steps before this one were never answered: none is done.
	expect(await doneSteps(page)).toEqual([]);
	await moveOn(page, 'skip', 'equipment');
	await expect(progress(page)).toHaveAttribute('aria-valuenow', '5');
	expect(await doneSteps(page)).toEqual(['strength']);
	await moveOn(page, 'continue', 'injuries');
	expect(await doneSteps(page)).toEqual(['strength', 'equipment']);

	// Back is a plain link to the step before, which stays done.
	await page.getByTestId('step-back').click();
	await expect(page).toHaveURL('/onboarding/equipment');
	await stepReady(page, 'equipment');
	expect(await doneSteps(page)).toEqual(['strength', 'equipment']);

	for (const step of ['welcome', 'goals', 'experience', 'schedule', 'review']) {
		await gotoHydrated(page, step === 'welcome' ? '/onboarding' : `/onboarding/${step}`);
		await stepReady(page, step);
		await expect(next(page), step).toBeEnabled();
		await expect(skip(page), step).toHaveCount(0);
	}
	await expect(skip(page)).toHaveCount(0);
});

test('goals: Continue without a goal is refused and says why; a crafted Skip changes nothing', async ({
	page,
	request
}) => {
	await gotoHydrated(page, '/onboarding/goals');
	await stepReady(page, 'goals');
	await next(page).click();
	await expect(page.getByRole('alert').filter({ hasText: 'Add at least one goal' })).toHaveText(
		'Add at least one goal to continue.'
	);
	await expect(page).toHaveURL('/onboarding/goals');

	const before = await query('select onboarding_step, onboarding_skipped from athlete_profiles');
	const crafted = await request.post('/onboarding/goals?/skip', {
		headers: { ...SAME_ORIGIN, accept: 'application/json', 'x-sveltekit-action': 'true' },
		multipart: { payload: '{}' }
	});
	expect(crafted.status()).toBe(400);
	expect(await crafted.json()).toMatchObject({ type: 'failure', status: 400 });
	expect(await query('select onboarding_step, onboarding_skipped from athlete_profiles')).toEqual(
		before
	);
});

test('strength goals only: no specifics step, and its URL goes on to the next step', async ({
	page,
	request
}) => {
	await profileAction(request, '/onboarding/goals?/saveGoal', strengthGoal);
	expect(await query('select source from training_goal_events')).toEqual([
		{ source: 'onboarding' }
	]);
	await gotoHydrated(page, '/onboarding/strength');
	await stepReady(page, 'strength');
	await expect(segments(page)).toHaveCount(10);
	await expect(page.getByTestId('step-progress').locator('[data-step="specifics"]')).toHaveCount(0);
	await page.goto('/onboarding/specifics');
	await expect(page).toHaveURL('/onboarding/equipment');
	expect((await page.goto('/onboarding/nowhere'))?.status()).toBe(404);
});

test('review: lifts by name with how each was found, and Edit comes back to the review', async ({
	page,
	request
}) => {
	await profileAction(request, '/onboarding/goals?/saveGoal', strengthGoal);
	await profileAction(request, '/profile/schedule?/save', schedule);
	await profileAction(request, '/profile/strength?/save', {
		unknown: false,
		lifts: [
			{ lift: 'weighted_pull_up', source: 'tested', value: 40, unit: 'kg' },
			{ lift: 'back_squat', source: 'set', unit: 'kg', setWeight: 100, setReps: 5, setRpe: 8 }
		]
	});
	await gotoHydrated(page, '/onboarding/review');
	await stepReady(page, 'review');
	const lifts = block(page, 'strength').getByRole('listitem');
	await expect(lifts.filter({ hasText: 'Weighted pull-up' })).toHaveText(
		/^Weighted pull-up\s*40 kg\s*Measured$/
	);
	await expect(lifts.filter({ hasText: 'Back squat' })).toHaveText(
		/^Back squat\s*≈ [\d.]+ kg\s*Estimated$/
	);
	await expect(block(page, 'strength')).not.toContainText('Week one');
	// A strength goal only: no running or Muay Thai, so no specifics block.
	await expect(block(page, 'specifics')).toHaveCount(0);

	// Edit → change → Continue: back to the review, not on to body.
	await expect(block(page, 'schedule')).toContainText('3 days a week');
	await block(page, 'schedule').getByRole('link', { name: 'Edit Schedule' }).click();
	await expect(page).toHaveURL('/onboarding/schedule?then=review');
	await stepReady(page, 'schedule');
	await expect(page.getByTestId('step-back')).toHaveAttribute('href', '/onboarding/review');
	const days = page.getByRole('spinbutton', { name: 'Training days a week' });
	await days.focus();
	await days.press('ArrowUp');
	await expect(days).toHaveAttribute('aria-valuenow', '4');
	await moveOn(page, 'continue', 'review');
	await expect(block(page, 'schedule')).toContainText('4 days a week');
	expect(await query('select days_per_week from schedules')).toEqual([{ days_per_week: 4 }]);

	// An optional step's Skip comes back too.
	await block(page, 'body').getByRole('link', { name: 'Edit Body & nutrition' }).click();
	await expect(page).toHaveURL('/onboarding/body?then=review');
	await stepReady(page, 'body');
	await moveOn(page, 'skip', 'review');
	expect(
		await query('select onboarding_completed, onboarding_skipped from athlete_profiles')
	).toEqual([{ onboarding_completed: ['schedule'], onboarding_skipped: ['body'] }]);

	// The welcome's Edit is an edit, not a return visit: no card to pick up elsewhere.
	await block(page, 'welcome').getByRole('link', { name: /^Edit/ }).click();
	await expect(page).toHaveURL('/onboarding?then=review');
	await stepReady(page, 'welcome');
	await expect(page.getByTestId('resume-card')).toHaveCount(0);
	await expect(ahead(page)).toHaveCount(0);
	await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Welcome back');
	await expect(page.getByTestId('step-back')).toHaveAttribute('href', '/onboarding/review');
});

test('review: Start coaching without a schedule says so on the schedule block and does not finish', async ({
	page,
	request
}) => {
	await profileAction(request, '/onboarding/goals?/saveGoal', strengthGoal);
	await profileAction(request, '/profile/schedule?/save', schedule);
	await gotoHydrated(page, '/onboarding/review');
	await stepReady(page, 'review');
	await expect(block(page, 'schedule')).toContainText('3 days a week');
	// Gone since the review loaded (another device, say): the server still checks.
	await query('delete from schedules');
	await next(page).click();
	const alert = block(page, 'schedule').getByRole('alert');
	await expect(alert).toHaveText('Tell your coach how many days you can train');
	await expect(page.getByRole('alert')).toHaveCount(1);
	await expect(block(page, 'goals').getByRole('alert')).toHaveCount(0);
	// The owner is taken to the block that needs them.
	await expect(block(page, 'schedule').getByRole('link', { name: 'Edit Schedule' })).toBeFocused();
	await expect(page).toHaveURL('/onboarding/review');
	expect(
		await query('select onboarding_completed_at is null as open from athlete_profiles')
	).toEqual([{ open: true }]);
});

/**
 * Record whether any error shows on the page from now on, even for a frame: a field marked
 * invalid, an alert or the step's error notice. Read it back with `flashed`.
 */
async function watchForErrors(page: Page) {
	await page.evaluate(() => {
		const w = window as unknown as { flashed: boolean };
		w.flashed = false;
		const seen = () =>
			document.querySelector('[aria-invalid="true"], [role="alert"], [data-testid="step-error"]');
		new MutationObserver(() => {
			if (seen()) w.flashed = true;
		}).observe(document.body, { subtree: true, childList: true, attributes: true });
	});
}
const flashed = (page: Page) =>
	page.evaluate(() => (window as unknown as { flashed: boolean }).flashed);

const experienceRows = () => query('select discipline, level, years from discipline_experience');
const completedSteps = () => query('select onboarding_completed from athlete_profiles');

test.describe('leaving a step: Back and Finish later', () => {
	test.beforeEach(async ({ request }) => {
		await profileAction(request, '/onboarding/goals?/saveGoal', strengthGoal);
	});

	test('Back keeps a changed level without marking the step done', async ({ page }) => {
		const errors = trackConsoleErrors(page);
		await gotoHydrated(page, '/onboarding/experience');
		await stepReady(page, 'experience');
		const entry = page.getByTestId('experience-entry');
		await entry.getByRole('radio', { name: 'Novice', exact: true }).check();
		await page.getByTestId('step-back').click();
		await expect(page).toHaveURL('/onboarding/goals');
		await stepReady(page, 'goals');
		expect(await experienceRows()).toEqual([
			{ discipline: 'strength', level: 'novice', years: null }
		]);
		expect(await completedSteps()).toEqual([{ onboarding_completed: [] }]);
		expect(await doneSteps(page)).toEqual([]);

		await gotoHydrated(page, '/onboarding/experience');
		await stepReady(page, 'experience');
		await expect(entry.getByRole('radio', { name: 'Novice', exact: true })).toBeChecked();
		expect(errors).toEqual([]);
	});

	test('a half-filled step that cannot save: Back still goes back, saves nothing and shows no error', async ({
		page
	}) => {
		await gotoHydrated(page, '/onboarding/experience');
		await stepReady(page, 'experience');
		// Years without a level: the level is required, so this entry cannot save yet.
		await page
			.getByTestId('experience-entry')
			.getByRole('textbox', { name: /^Years/ })
			.fill('3');
		await watchForErrors(page);
		await page.getByTestId('step-back').click();
		await expect(page).toHaveURL('/onboarding/goals');
		await stepReady(page, 'goals');
		expect(await flashed(page)).toBe(false);
		expect(await experienceRows()).toEqual([]);
		expect(await completedSteps()).toEqual([{ onboarding_completed: [] }]);
	});

	test('Finish later on a changed step goes to Today, and the change is saved', async ({
		page
	}) => {
		await gotoHydrated(page, '/onboarding/equipment');
		await stepReady(page, 'equipment');
		await page.getByRole('radio', { name: 'Commercial gym' }).check();
		await page.getByTestId('finish-later').click();
		await expect(page).toHaveURL('/today');
		expect(await query('select gym_type from equipment_profiles')).toEqual([
			{ gym_type: 'commercial' }
		]);
		expect(await completedSteps()).toEqual([{ onboarding_completed: [] }]);
	});

	test('opened from the review, Back saves the change and returns to the review', async ({
		page
	}) => {
		await gotoHydrated(page, '/onboarding/review');
		await stepReady(page, 'review');
		await block(page, 'equipment').getByRole('link', { name: 'Edit Equipment' }).click();
		await expect(page).toHaveURL('/onboarding/equipment?then=review');
		await stepReady(page, 'equipment');
		await page.getByRole('radio', { name: 'Commercial gym' }).check();
		await page.getByTestId('step-back').click();
		await expect(page).toHaveURL('/onboarding/review');
		await stepReady(page, 'review');
		await expect(block(page, 'equipment')).toContainText('Commercial gym');
		expect(await query('select gym_type from equipment_profiles')).toEqual([
			{ gym_type: 'commercial' }
		]);
		expect(await completedSteps()).toEqual([{ onboarding_completed: [] }]);
	});

	test.describe('with the service worker blocked (page.route must see every request)', () => {
		test.use({ serviceWorkers: 'block' });

		// The step before has its own Back where this one was, under the pointer the click left
		// there. Resting on it must not fetch the welcome's data: leaving the page next would
		// cancel that request, which WebKit reports as a page error.
		test('the pointer resting where Back was starts no request a page load then cancels', async ({
			page
		}) => {
			const errors = trackConsoleErrors(page);
			const welcomeData: string[] = [];
			await page.route('**/onboarding/__data.json?*', (route) => {
				welcomeData.push(route.request().url());
			});
			await gotoHydrated(page, '/onboarding/experience');
			await stepReady(page, 'experience');
			await page
				.getByTestId('experience-entry')
				.getByRole('radio', { name: 'Novice', exact: true })
				.check();
			await page.getByTestId('step-back').click();
			await stepReady(page, 'goals');
			const box = (await page.getByTestId('step-back').boundingBox())!;
			await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2);
			await page.waitForTimeout(200); // past SvelteKit's 20 ms hover delay
			await gotoHydrated(page, '/onboarding/experience');
			await stepReady(page, 'experience');
			expect(welcomeData).toEqual([]);
			expect(errors).toEqual([]);
		});
	});
});

test.describe('with the service worker blocked (page.route must see every request)', () => {
	test.use({ serviceWorkers: 'block' });

	test('Continue with no connection says so and stays on the step', async ({ page }) => {
		await gotoHydrated(page, '/onboarding/equipment');
		await stepReady(page, 'equipment');
		await page.route('**/onboarding/equipment?/save', (route) =>
			route.abort('internetdisconnected')
		);
		await next(page).click();
		await expect(page.getByTestId('step-error')).toHaveText(
			'Can’t reach the server. Check your connection.'
		);
		await expect(page).toHaveURL('/onboarding/equipment');
		await expect(toastWith(page, 'Saved')).toHaveCount(0);
		expect(await query('select onboarding_completed from athlete_profiles')).toEqual([
			{ onboarding_completed: [] }
		]);
	});
});

test.describe('in a desktop window', () => {
	test.use(DESKTOP);

	test('one readable column centred in the window, with Continue at its foot', async ({
		page
	}, testInfo) => {
		await gotoHydrated(page, '/onboarding/equipment');
		await stepReady(page, 'equipment');
		const main = page.locator('main#main');
		const box = (await main.boundingBox())!;
		expect(Math.abs(box.width - (await tokenPx(page, '--content-readable')))).toBeLessThanOrEqual(
			1
		);
		const right = (await layoutWidth(page)) - box.x - box.width;
		expect(Math.abs(box.x - right), `gaps beside main: ${box.x} and ${right}`).toBeLessThanOrEqual(
			1
		);
		await expectCentredOver(page, page.locator('.actions .buttons'), main);
		await expectNoSideScroll(page);
		// A mouse gets a hover state on the step's links, which keyboard focus also shows.
		const later = page.getByTestId('finish-later');
		const colour = () => later.evaluate((el) => getComputedStyle(el).color);
		const resting = await colour();
		await later.hover();
		await expect.poll(colour).not.toBe(resting);
		await captureScreen(page, testInfo, 'onboarding-desktop');
	});

	test('a return visit: the resume card sits in the same column, its link with a hover state', async ({
		page
	}, testInfo) => {
		await gotoHydrated(page, '/onboarding');
		await stepReady(page, 'welcome');
		await moveOn(page, 'continue', 'goals');
		await gotoHydrated(page, '/onboarding');
		await stepReady(page, 'welcome');
		const card = page.getByTestId('resume-card');
		await expect(card).toContainText('You stopped at Your goals');
		const main = page.locator('main#main');
		const [cardBox, mainBox] = [(await card.boundingBox())!, (await main.boundingBox())!];
		expect(cardBox.x).toBeGreaterThanOrEqual(mainBox.x);
		expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(mainBox.x + mainBox.width);
		await expectNoSideScroll(page);
		const link = card.getByRole('link', { name: 'Pick up there' });
		const background = () => link.evaluate((el) => getComputedStyle(el).backgroundColor);
		const resting = await background();
		await link.hover();
		await expect.poll(background).not.toBe(resting);
		await captureScreen(page, testInfo, 'onboarding-resume-desktop');
	});

	test('the review: blocks centred in the column, and Edit has a hover state', async ({
		page
	}, testInfo) => {
		await gotoHydrated(page, '/onboarding/review');
		await stepReady(page, 'review');
		const main = page.locator('main#main');
		await expectCentredOver(page, block(page, 'goals'), main);
		await expectNoSideScroll(page);
		const edit = block(page, 'goals').getByRole('link', { name: 'Edit Your goals' });
		const tint = () => edit.evaluate((el) => getComputedStyle(el).backgroundColor);
		const resting = await tint();
		await edit.hover();
		await expect.poll(tint).not.toBe(resting);
		await captureScreen(page, testInfo, 'onboarding-review-desktop');
	});
});
