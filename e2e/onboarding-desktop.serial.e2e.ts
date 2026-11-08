/**
 * Onboarding in a desktop window (1440 × 900; docs/design-system.md, Responsive layout →
 * Screens): each step is a card centred in the window, the progress bar across its top and
 * Back, Skip and Continue in a row under the form, all in view without scrolling; the review is wide, its blocks in two columns. The designed states (no
 * connection, no goal yet) keep that layout, their notice in the card above the action row.
 * Serial, like onboarding.serial.e2e.ts: every test starts from a blank training profile, and
 * the last one leaves it blank again.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import {
	boxOf,
	DESKTOP,
	expectInColumn,
	expectNoShift,
	expectNoSideScroll,
	expectStableBoxes,
	layoutWidth,
	tokenPx
} from './desktop';
import {
	captureScreen,
	gotoHydrated,
	profileAction,
	resetTrainingProfile,
	trackConsoleErrors
} from './support';

test.use(DESKTOP);

const card = (page: Page) => page.locator('main#main > .step');
const actionRow = (page: Page) => page.locator('main#main > .step > .actions');
const form = (page: Page) => page.getByTestId('section-editor');
const back = (page: Page) => page.getByTestId('step-back-row');
const next = (page: Page) => page.getByTestId('step-continue');
const skip = (page: Page) => page.getByTestId('step-skip');
const stepError = (page: Page) => page.getByTestId('step-error');
const block = (page: Page, step: string) => page.getByTestId(`summary-${step}`);

const strengthGoal = {
	kind: 'general',
	title: 'Get stronger',
	disciplines: ['strength'],
	focus: 'Squat and deadlift',
	measure: 'Top sets at RPE 8 go up'
};
const schedule = { daysPerWeek: 3, availableDays: [], preferredTimes: [], commitments: [] };

/** The step's editor has loaded in place of its skeleton: Continue and Skip work from here. */
async function stepReady(page: Page, step: string) {
	await expect(page.locator(`.step[data-step="${step}"]`)).toBeVisible();
	await expect(form(page)).toHaveAttribute('aria-busy', 'false');
}

const path = (step: string) => (step === 'welcome' ? '/onboarding' : `/onboarding/${step}`);

async function auditBothThemes(page: Page, label: string) {
	for (const theme of ['dark', 'light'] as const) {
		await page.evaluate((t) => {
			if (t === 'dark') delete document.documentElement.dataset.theme;
			else document.documentElement.dataset.theme = t;
		}, theme);
		await page.waitForTimeout(400);
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		expect(
			violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`)),
			`${label} (${theme})`
		).toEqual([]);
	}
	await page.evaluate(() => delete document.documentElement.dataset.theme);
}

/**
 * The step's card: centred in the window at the width the step declares, the progress bar
 * across its top edge, and the action row inside it under the form (covering none of it), with
 * Continue a button in that row rather than a full-width bar, wholly in view with the page
 * unscrolled. Nothing scrolls sideways.
 */
async function expectCard(page: Page, width: '--content-readable' | '--content-wide') {
	const box = await boxOf(card(page));
	const declared = await tokenPx(page, width);
	expect(Math.abs(box.width - declared), `the card is ${box.width}px`).toBeLessThanOrEqual(1);
	const right = (await layoutWidth(page)) - box.x - box.width;
	expect(
		Math.abs(box.x - right),
		`gaps beside the card: ${box.x} and ${right}`
	).toBeLessThanOrEqual(1);
	const bar = await boxOf(page.getByTestId('step-progress'));
	expect(bar.y - box.y, 'the progress bar runs along the card’s top edge').toBeLessThanOrEqual(2);
	expect(box.width - bar.width, 'the progress bar spans the card').toBeLessThanOrEqual(2);
	await expectInColumn(page, actionRow(page), card(page), [form(page)]);
	await expect(next(page)).toBeInViewport({ ratio: 1 });
	const row = await boxOf(actionRow(page));
	const button = await boxOf(next(page));
	expect(button.width, 'Continue is a button in the row, not a bar').toBeLessThan(row.width / 2);
	expect(button.y, 'Continue is under the form').toBeGreaterThanOrEqual(
		(await boxOf(form(page))).y
	);
	// Back, where there is one, opens the same row: the header's is hidden, out of the focus order.
	if (await back(page).count()) {
		await expect(page.getByTestId('step-back')).toBeHidden();
		await expect(back(page)).toBeInViewport({ ratio: 1 });
		const link = await boxOf(back(page));
		expect(link.y, 'Back is in the row under the form').toBeGreaterThanOrEqual(row.y);
		expect(
			Math.abs(link.y + link.height / 2 - (button.y + button.height / 2)),
			'Back sits level with Continue'
		).toBeLessThanOrEqual(1);
		expect(link.x + link.width, 'Back is left of Continue').toBeLessThanOrEqual(button.x);
		expect(link.height).toBeGreaterThanOrEqual(44);
	}
	expect(await page.evaluate(() => window.scrollY), 'the page is not scrolled').toBe(0);
	await expectNoSideScroll(page);
}

/** Press Tab until `target` has focus (the keyboard alone, in reading order). */
async function tabTo(page: Page, target: Locator, max = 60) {
	for (let i = 0; i < max; i++) {
		if (await target.evaluate((el) => el === document.activeElement)) return;
		await page.keyboard.press('Tab');
	}
	await expect(target, `Tab reaches ${target}`).toBeFocused();
}

/** Tab into a choice group, then move with the arrow keys until `choice` is checked. */
async function arrowTo(page: Page, group: Locator, choice: Locator) {
	for (let i = 0; i < 60; i++) {
		if (await group.evaluate((el) => el.contains(document.activeElement))) break;
		await page.keyboard.press('Tab');
	}
	if (!(await choice.isChecked())) await page.keyboard.press('Space');
	for (let i = 0; i < 6 && !(await choice.isChecked()); i++) {
		await page.keyboard.press('ArrowRight');
	}
	await expect(choice).toBeChecked();
	await expect(choice).toBeFocused();
}

/** Press `key` on the focused Continue or Skip and land on `to`, ready. */
async function pressOn(page: Page, key: 'Enter' | 'Space', to: string) {
	await page.keyboard.press(key);
	await expect(page).toHaveURL(path(to));
	await stepReady(page, to);
}

/** The step's layout, its screenshot and axe in both themes. */
async function checkStep(page: Page, testInfo: TestInfo, step: string) {
	await expectCard(page, step === 'review' ? '--content-wide' : '--content-readable');
	await captureScreen(page, testInfo, `onboarding-desktop-${step}`);
	await auditBothThemes(page, step);
}

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test.afterAll(async () => {
	await resetTrainingProfile();
});

test('welcome to review with the keyboard alone, each step a card with its actions in view', async ({
	page
}, testInfo) => {
	test.setTimeout(240_000);
	const errors = trackConsoleErrors(page);
	await gotoHydrated(page, '/onboarding');
	await stepReady(page, 'welcome');
	await checkStep(page, testInfo, 'welcome');
	await tabTo(page, page.getByRole('textbox', { name: 'What should your coach call you?' }));
	await page.keyboard.type('Niko');
	const weights = page.getByRole('radiogroup', { name: 'Weights in' });
	await arrowTo(page, weights, weights.getByRole('radio', { name: 'kg' }));
	await tabTo(page, next(page));
	await pressOn(page, 'Enter', 'goals');

	// A general running goal through its sheet (it brings the specifics step): typing, Space on a
	// checkbox, Enter on Save goal.
	await checkStep(page, testInfo, 'goals');
	await tabTo(page, page.getByTestId('goal-path-general'));
	await page.keyboard.press('Enter');
	const sheet = page.getByTestId('goal-sheet');
	await expect(sheet.getByRole('heading', { name: 'New goal' })).toBeVisible();
	await tabTo(page, sheet.getByRole('textbox', { name: 'Goal', exact: true }));
	await page.keyboard.type('Run further');
	const running = sheet.getByRole('checkbox', { name: 'Running', exact: true });
	await tabTo(page, running);
	await page.keyboard.press('Space');
	await expect(running).toBeChecked();
	await tabTo(page, sheet.getByRole('textbox', { name: 'What to improve' }));
	await page.keyboard.type('Aerobic base');
	await tabTo(page, sheet.getByRole('textbox', { name: 'How it’s measured' }));
	await page.keyboard.type('Easy pace drops');
	await tabTo(page, sheet.getByTestId('goal-save'));
	await page.keyboard.press('Enter');
	await expect(sheet).toBeHidden();
	await expect(page.getByTestId('goal-row')).toHaveCount(1);
	await tabTo(page, next(page));
	await pressOn(page, 'Enter', 'experience');

	await checkStep(page, testInfo, 'experience');
	const level = page.getByTestId('experience-entry').getByRole('group', { name: 'Level' });
	await arrowTo(page, level, level.getByRole('radio', { name: 'Novice' }));
	// The focus order follows the layout: the form, then Back, then Continue.
	await tabTo(page, back(page));
	await page.keyboard.press('Tab');
	await expect(next(page)).toBeFocused();
	await pressOn(page, 'Enter', 'strength');

	await checkStep(page, testInfo, 'strength');
	const unknown = page.getByRole('switch', { name: 'I don’t know my 1RMs' });
	await tabTo(page, unknown);
	await page.keyboard.press('Space');
	await expect(unknown).toBeChecked();
	await tabTo(page, next(page));
	await pressOn(page, 'Enter', 'specifics');

	await checkStep(page, testInfo, 'specifics');
	const pace = page
		.getByRole('region', { name: 'Running', exact: true })
		.getByRole('textbox', { name: 'Easy pace', exact: true });
	await tabTo(page, pace);
	await page.keyboard.type('5.45');
	await tabTo(page, next(page));
	await pressOn(page, 'Enter', 'equipment');

	// Moving on keeps the card and its action row where they were.
	for (const [step, to] of [
		['equipment', 'injuries'],
		['injuries', 'exercises'],
		['exercises', 'schedule']
	] as const) {
		await checkStep(page, testInfo, step);
		await tabTo(page, skip(page));
		await expectNoShift(page, {
			action: () => pressOn(page, 'Space', to),
			boxes: [card(page), actionRow(page)]
		});
	}

	await checkStep(page, testInfo, 'schedule');
	const days = page.getByRole('spinbutton', { name: 'Training days a week' });
	await tabTo(page, days);
	await page.keyboard.press('ArrowUp');
	await expect(days).toHaveAttribute('aria-valuenow', '5');
	await tabTo(page, next(page));
	await pressOn(page, 'Enter', 'body');

	await checkStep(page, testInfo, 'body');
	await tabTo(page, skip(page));
	await pressOn(page, 'Space', 'review');

	// The review is wide: its blocks pair up, in reading order across each row.
	await checkStep(page, testInfo, 'review');
	await expectTwoColumns(page);

	// Edit from the review comes back to it.
	await tabTo(page, block(page, 'schedule').getByRole('link', { name: 'Edit Schedule' }));
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL('/onboarding/schedule?then=review');
	await stepReady(page, 'schedule');
	await expectCard(page, '--content-readable');
	await tabTo(page, next(page));
	await pressOn(page, 'Enter', 'review');
	await expect(block(page, 'schedule')).toContainText('5 days a week');

	await tabTo(page, next(page));
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL('/today');
	expect(errors).toEqual([]);
});

/** The review's blocks in two columns: the first two side by side, the third under the first. */
async function expectTwoColumns(page: Page) {
	const [welcome, goals, experience] = [
		await boxOf(block(page, 'welcome')),
		await boxOf(block(page, 'goals')),
		await boxOf(block(page, 'experience'))
	];
	expect(Math.abs(goals.y - welcome.y), 'Name & units and Goals start level').toBeLessThanOrEqual(
		1
	);
	expect(goals.x, 'Goals sits right of Name & units').toBeGreaterThanOrEqual(
		welcome.x + welcome.width
	);
	expect(Math.abs(experience.x - welcome.x), 'Experience under Name & units').toBeLessThanOrEqual(
		1
	);
	expect(experience.y).toBeGreaterThanOrEqual(welcome.y + welcome.height);
}

test('goals: Continue with no goal announces why and takes focus there, above the action row', async ({
	page
}, testInfo) => {
	await gotoHydrated(page, '/onboarding/goals');
	await stepReady(page, 'goals');
	await tabTo(page, next(page));
	await expectStableBoxes(page, [card(page)], async () => {
		await page.keyboard.press('Enter');
		await expect(page.getByRole('alert').filter({ hasText: 'Add at least one goal' })).toHaveText(
			'Add at least one goal to continue.'
		);
	});
	await expect(stepError(page)).toBeFocused();
	await expect(page).toHaveURL('/onboarding/goals');
	await expectErrorAboveActions(page);
	await captureScreen(page, testInfo, 'onboarding-desktop-goals-error');
	await auditBothThemes(page, 'goals, no goal');
});

/** The step's notice is in the card's action row, above Continue, all in view. */
async function expectErrorAboveActions(page: Page) {
	await expectCard(page, '--content-readable');
	await expectInColumn(page, stepError(page), actionRow(page), []);
	const notice = await boxOf(stepError(page));
	const button = await boxOf(next(page));
	expect(notice.y + notice.height, 'the notice is above Continue').toBeLessThanOrEqual(
		button.y + 1
	);
	await expect(stepError(page)).toBeInViewport({ ratio: 1 });
}

test.describe('with the service worker blocked (page.route must see every request)', () => {
	test.use({ serviceWorkers: 'block' });

	test('Continue with no connection: the notice in the card, the step and its answer kept', async ({
		page
	}, testInfo) => {
		await gotoHydrated(page, '/onboarding/equipment');
		await stepReady(page, 'equipment');
		const gym = page.getByRole('radio', { name: 'Commercial gym' });
		await gym.check();
		await page.route('**/onboarding/equipment?/save', (route) =>
			route.abort('internetdisconnected')
		);
		await expectStableBoxes(page, [card(page)], async () => {
			await next(page).click();
			await expect(stepError(page)).toHaveText('Can’t reach the server. Check your connection.');
		});
		await expect(page).toHaveURL('/onboarding/equipment');
		await expect(gym).toBeChecked();
		await expect(stepError(page)).toBeFocused();
		await expectErrorAboveActions(page);
		await captureScreen(page, testInfo, 'onboarding-desktop-offline');
		await auditBothThemes(page, 'equipment, offline');
	});
});

test('the review: wide, two columns, and Edit has a hover state', async ({
	page,
	request
}, testInfo) => {
	await profileAction(request, '/onboarding/goals?/saveGoal', strengthGoal);
	await profileAction(request, '/profile/schedule?/save', schedule);
	await gotoHydrated(page, '/onboarding/review');
	await stepReady(page, 'review');
	await expectCard(page, '--content-wide');
	await expectTwoColumns(page);
	const edit = block(page, 'goals').getByRole('link', { name: 'Edit Your goals' });
	const tint = () => edit.evaluate((el) => getComputedStyle(el).backgroundColor);
	const resting = await tint();
	await edit.hover();
	await expect.poll(tint).not.toBe(resting);
	await captureScreen(page, testInfo, 'onboarding-desktop-review-seeded');
});

test('Back and Finish later have hover states; a return visit’s card sits in the column', async ({
	page
}, testInfo) => {
	await gotoHydrated(page, '/onboarding');
	await stepReady(page, 'welcome');
	await next(page).click();
	await expect(page).toHaveURL('/onboarding/goals');
	await stepReady(page, 'goals');
	for (const link of [back(page), page.getByTestId('finish-later')]) {
		const colour = () => link.evaluate((el) => getComputedStyle(el).color);
		const resting = await colour();
		await link.hover();
		await expect.poll(colour).not.toBe(resting);
	}

	await gotoHydrated(page, '/onboarding');
	await stepReady(page, 'welcome');
	const resume = page.getByTestId('resume-card');
	await expect(resume).toContainText('You stopped at Your goals');
	await expectCard(page, '--content-readable');
	await expectInColumn(page, resume, card(page), []);
	const link = resume.getByRole('link', { name: 'Pick up there' });
	const background = () => link.evaluate((el) => getComputedStyle(el).backgroundColor);
	const resting = await background();
	await link.hover();
	await expect.poll(background).not.toBe(resting);
	await captureScreen(page, testInfo, 'onboarding-desktop-resume');
});
