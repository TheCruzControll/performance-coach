/**
 * Profile → Experience: the owner's level, years and sessions a week in each discipline. Serial
 * (one test at a time, after the functional suites): every test starts from a blank training
 * profile, which every browser and worker shares.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
	captureScreen,
	gotoHydrated,
	profileAction,
	query,
	resetTrainingProfile,
	toastWith,
	trackConsoleErrors
} from './support';

/**
 * Open goals in these disciplines, ranked in this order. Nothing saves a goal from a screen yet,
 * so they go straight into the table the goal services write.
 */
async function seedGoals(...disciplines: string[]) {
	for (const [i, discipline] of disciplines.entries()) {
		await query(
			`insert into training_goals (owner_id, kind, title, disciplines, priority, focus)
			 select id, 'general', $1, $2::text[], $3, 'Get better at it' from owners`,
			[`Goal ${i + 1}`, [discipline], i + 1]
		);
	}
}

/** The owner's experience rows, numbers as numbers. */
const rows = () =>
	query(
		`select discipline, custom_label, level, years::float8 as years,
		        sessions_per_week::float8 as sessions
		 from discipline_experience order by discipline, custom_label`
	);

/** The editor has loaded in place of the skeleton. */
async function editorReady(page: Page) {
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
}

const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const level = (page: Page, discipline: string, name: string) =>
	card(page, discipline).getByRole('radio', { name, exact: true });
const years = (page: Page, discipline: string) =>
	card(page, discipline).getByRole('textbox', { name: /^Years/ });
const sessions = (page: Page, discipline: string) =>
	card(page, discipline).getByRole('textbox', { name: /^Sessions/ });
const titles = (page: Page) => page.getByTestId('experience-entry').getByRole('heading');

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test('the goals’ disciplines are listed already, and a card without a level stops Save there', async ({
	page
}) => {
	const errors = trackConsoleErrors(page);
	await seedGoals('muay_thai', 'powerlifting');
	await gotoHydrated(page, '/profile');
	await page
		.getByRole('region', { name: 'Training profile' })
		.getByRole('link', { name: /Experience/ })
		.click();
	await expect(page).toHaveURL('/profile/experience');
	await expect(page.getByRole('heading', { level: 1, name: 'Experience' })).toBeVisible();
	await editorReady(page);
	// In catalog order, whatever order the goals are ranked in.
	await expect(titles(page)).toHaveText(['Powerlifting', 'Muay Thai']);

	await level(page, 'Powerlifting', 'Intermediate').check();
	await page.getByTestId('save-section').click();
	await expect(card(page, 'Muay Thai').getByRole('alert')).toHaveText('Pick your level');
	await expect(card(page, 'Powerlifting').getByRole('alert')).toHaveCount(0);
	await expect(level(page, 'Muay Thai', 'New')).toBeFocused();
	await expect(page.getByTestId('save-error')).toContainText('Check the highlighted fields');
	expect(await rows()).toEqual([]);
	expect(errors).toEqual([]);
});

test('levels, years and sessions save, and are there after a reload and in Postgres', async ({
	page
}, testInfo) => {
	await seedGoals('powerlifting', 'muay_thai');
	await page.goto('/profile/experience');
	await editorReady(page);
	await level(page, 'Powerlifting', 'Intermediate').check();
	await expect(card(page, 'Powerlifting').getByText('Steady, structured training')).toBeVisible();
	// Years take a decimal point on the phone's keypad; sessions are whole numbers.
	await expect(years(page, 'Powerlifting')).toHaveAttribute('inputmode', 'decimal');
	await expect(sessions(page, 'Powerlifting')).toHaveAttribute('inputmode', 'numeric');
	await years(page, 'Powerlifting').fill('2.5');
	await sessions(page, 'Powerlifting').fill('4');
	await level(page, 'Muay Thai', 'Novice').check();
	await sessions(page, 'Muay Thai').fill('2');

	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	expect(await rows()).toEqual([
		{ discipline: 'muay_thai', custom_label: '', level: 'novice', years: null, sessions: 2 },
		{
			discipline: 'powerlifting',
			custom_label: '',
			level: 'intermediate',
			years: 2.5,
			sessions: 4
		}
	]);
	await page.evaluate(() => scrollTo(0, 0));
	await captureScreen(page, testInfo, 'profile-experience');

	await page.reload();
	await editorReady(page);
	await expect(titles(page)).toHaveText(['Powerlifting', 'Muay Thai']);
	await expect(level(page, 'Powerlifting', 'Intermediate')).toBeChecked();
	await expect(years(page, 'Powerlifting')).toHaveValue('2.5');
	await expect(sessions(page, 'Powerlifting')).toHaveValue('4');
	await expect(level(page, 'Muay Thai', 'Novice')).toBeChecked();
	await expect(years(page, 'Muay Thai')).toHaveValue('');
	await expect(sessions(page, 'Muay Thai')).toHaveValue('2');

	// Nothing unsaved: leaving asks nothing.
	await page.getByTestId('back-to-profile').click();
	await expect(page).toHaveURL('/profile');
});

test('disciplines add with buttons that arrow keys never press, and a custom one needs a name', async ({
	page
}) => {
	await seedGoals('powerlifting');
	await page.goto('/profile/experience');
	await editorReady(page);
	await expect(titles(page)).toHaveText(['Powerlifting']);

	// A radio group here would add one discipline per arrow key; buttons add nothing.
	const addRunning = page.getByRole('button', { name: 'Add Running', exact: true });
	await addRunning.focus();
	for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
		await page.keyboard.press(key);
	}
	await expect(titles(page)).toHaveText(['Powerlifting']);
	await expect(addRunning).toBeFocused();

	// Added, it leaves the row and its card asks for a level first.
	await page.keyboard.press('Enter');
	await expect(titles(page)).toHaveText(['Powerlifting', 'Running']);
	await expect(addRunning).toHaveCount(0);
	await expect(level(page, 'Running', 'New')).toBeFocused();

	await page.getByRole('button', { name: 'Add other discipline' }).click();
	const name = card(page, 'Something else').getByRole('textbox', { name: 'What is it?' });
	await expect(name).toBeFocused();
	await level(page, 'Something else', 'New').check();
	await level(page, 'Powerlifting', 'Advanced').check();
	await level(page, 'Running', 'Novice').check();
	await page.getByTestId('save-section').click();
	await expect(card(page, 'Something else').getByRole('alert')).toHaveText('Name this discipline');
	await expect(name).toBeFocused();
	expect(await rows()).toEqual([]);

	await name.fill('Climbing');
	await expect(titles(page)).toHaveText(['Powerlifting', 'Running', 'Climbing']);
	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	expect(await rows()).toEqual([
		{ discipline: 'custom', custom_label: 'Climbing', level: 'new', years: null, sessions: null },
		{
			discipline: 'powerlifting',
			custom_label: '',
			level: 'advanced',
			years: null,
			sessions: null
		},
		{ discipline: 'running', custom_label: '', level: 'novice', years: null, sessions: null }
	]);
});

test('removing a card in the middle leaves the others as they were, errors included', async ({
	page,
	request
}) => {
	await seedGoals('powerlifting', 'muay_thai');
	await profileAction(request, '/profile/experience?/save', {
		entries: [{ discipline: 'running', level: 'intermediate', years: 3, sessionsPerWeek: 4 }]
	});
	await page.goto('/profile/experience');
	await editorReady(page);
	// What was saved first, then a blank card for each goal discipline without one.
	await expect(titles(page)).toHaveText(['Running', 'Powerlifting', 'Muay Thai']);
	await level(page, 'Muay Thai', 'Advanced').check();
	await years(page, 'Muay Thai').fill('6');
	await page.getByTestId('save-section').click();
	await expect(card(page, 'Powerlifting').getByRole('alert')).toHaveText('Pick your level');

	// The card below stays the same element, so nothing in it (half-typed text, say) moves.
	await card(page, 'Muay Thai').evaluate((el) => el.setAttribute('data-kept', ''));
	const remove = page.getByRole('button', { name: 'Remove Powerlifting' });
	await remove.focus();
	await page.keyboard.press('Enter');
	await expect(titles(page)).toHaveText(['Running', 'Muay Thai']);
	await expect(card(page, 'Muay Thai')).toHaveAttribute('data-kept', '');
	// Its error left with it, and keyboard focus moved to the next card's Remove.
	await expect(page.getByTestId('experience-entry').getByRole('alert')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Remove Muay Thai' })).toBeFocused();
	await expect(level(page, 'Running', 'Intermediate')).toBeChecked();
	await expect(years(page, 'Running')).toHaveValue('3');
	await expect(sessions(page, 'Running')).toHaveValue('4');
	await expect(level(page, 'Muay Thai', 'Advanced')).toBeChecked();
	await expect(years(page, 'Muay Thai')).toHaveValue('6');

	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	expect(await rows()).toEqual([
		{ discipline: 'muay_thai', custom_label: '', level: 'advanced', years: 6, sessions: null },
		{ discipline: 'running', custom_label: '', level: 'intermediate', years: 3, sessions: 4 }
	]);

	// A goal discipline without experience is asked about again while its goal is open.
	await page.reload();
	await editorReady(page);
	await expect(titles(page)).toHaveText(['Running', 'Muay Thai', 'Powerlifting']);
	await expect(card(page, 'Powerlifting').getByRole('radio', { checked: true })).toHaveCount(0);
});

test('with nothing in play the screen says what to add, and comes back to that empty', async ({
	page
}, testInfo) => {
	await page.goto('/profile/experience');
	await editorReady(page);
	const empty = page.getByTestId('experience-empty');
	await expect(empty).toContainText('No disciplines yet');
	await expect(page.getByRole('heading', { name: 'What do you train?' })).toBeVisible();
	await captureScreen(page, testInfo, 'profile-experience-empty');

	await page.getByRole('button', { name: 'Add Muay Thai' }).click();
	await expect(empty).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'Also train something else?' })).toBeVisible();
	await page.getByRole('button', { name: 'Remove Muay Thai' }).click();
	await expect(empty).toBeVisible();
	await expect(page.getByTestId('experience-entry')).toHaveCount(0);
	// The card went without a trace on screen: a screen reader hears it.
	await expect(page.getByRole('status').filter({ hasText: 'Removed Muay Thai' })).toHaveCount(1);
});

for (const theme of ['dark', 'light'] as const) {
	test(`cards, their errors and a custom discipline have no WCAG A/AA violations (${theme})`, async ({
		page
	}, testInfo) => {
		await page.addInitScript(
			(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
			theme
		);
		await seedGoals('powerlifting', 'muay_thai');
		await page.goto('/profile/experience');
		await editorReady(page);
		if (theme === 'light')
			await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await level(page, 'Powerlifting', 'Intermediate').check();
		await page.getByRole('button', { name: 'Add other discipline' }).click();
		await page.getByTestId('save-section').click();
		await expect(card(page, 'Muay Thai').getByRole('alert')).toBeVisible();
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(400);
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		expect(violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))).toEqual(
			[]
		);
		await captureScreen(page, testInfo, `profile-experience-errors-${theme}`);
	});
}
