/**
 * Profile → Experience: the owner's level, years and sessions a week in each discipline, a row
 * each, opening a sheet that holds them. Serial
 * (one test at a time, after the functional suites): every test starts from a blank training
 * profile, which every browser and worker shares.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
	captureScreen,
	gotoHydrated,
	openSheet,
	profileAction,
	query,
	resetTrainingProfile,
	setLevel,
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

/** The editor has loaded under the title. */
async function editorReady(page: Page) {
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
}

/** A discipline's row: its accessible name is the discipline, then its level ("Choose"). */
const entry = (page: Page, name: string) =>
	page.getByTestId('experience-entry').filter({ hasText: name });
const titles = (page: Page) => page.getByTestId('experience-entry').locator('.title');
/** A discipline's sheet, opened from its row and titled with its name. */
const sheetOf = (page: Page, name: string) => openSheet(page, page, new RegExp(`^${name}`), name);
const level = (sheet: Locator, name: string) =>
	sheet.getByRole('radio', { name: new RegExp(`^${name}\\b`) });
const years = (sheet: Locator) => sheet.getByRole('textbox', { name: /^Years/ });
const sessions = (sheet: Locator) => sheet.getByRole('textbox', { name: /^Sessions/ });

/** Close a sheet with Escape: what was typed or picked stays. */
async function closeSheet(page: Page, sheet: Locator) {
	await page.keyboard.press('Escape');
	await expect(sheet).toBeHidden();
}

/** "Add something else you train": pick it, and the new discipline's own sheet opens. */
async function addDiscipline(page: Page, pick: string, title: string): Promise<Locator> {
	await page.getByTestId('add-discipline').click();
	const adding = page.getByRole('dialog', { name: 'What else do you train?' });
	await adding.getByRole('radio', { name: pick, exact: true }).click();
	await expect(adding).toBeHidden();
	const sheet = page.getByRole('dialog', { name: title, exact: true });
	await expect(sheet).toBeVisible();
	return sheet;
}

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test('the goals’ disciplines are listed already, and a row without a level stops Save there', async ({
	page
}) => {
	const errors = trackConsoleErrors(page);
	await seedGoals('muay_thai', 'powerlifting');
	await gotoHydrated(page, '/profile');
	await page.getByTestId('section-experience').click();
	await expect(page).toHaveURL('/profile/experience');
	await expect(page.getByRole('heading', { level: 1, name: 'Experience' })).toBeVisible();
	await editorReady(page);
	// Paper, 9 · "Experience": the lede, then a row each, in catalog order whatever order the
	// goals are ranked in, saying "Choose" until it has a level.
	await expect(page.getByText('Your level in each thing you train.')).toBeVisible();
	await expect(titles(page)).toHaveText(['Powerlifting', 'Muay Thai']);
	await expect(entry(page, 'Powerlifting')).toHaveAccessibleName(/^Powerlifting\s*Choose/);

	await setLevel(page, entry(page, 'Powerlifting'), 'Intermediate');
	await expect(entry(page, 'Powerlifting')).toHaveAccessibleName(/^Powerlifting\s*Intermediate/);
	await page.getByTestId('save-section').click();
	await expect(entry(page, 'Muay Thai')).toHaveAccessibleDescription('Pick your level');
	await expect(entry(page, 'Powerlifting')).not.toHaveAttribute('aria-invalid');
	await expect(entry(page, 'Muay Thai')).toBeFocused();
	await expect(page.getByTestId('save-error')).toContainText('Check the highlighted fields');
	// Opened, its sheet shows the message on the level list.
	const muayThai = await sheetOf(page, 'Muay Thai');
	await expect(muayThai.getByRole('alert')).toHaveText('Pick your level');
	await closeSheet(page, muayThai);
	expect(await rows()).toEqual([]);
	expect(errors).toEqual([]);
});

test('levels, years and sessions save, and are there after a reload and in Postgres', async ({
	page
}, testInfo) => {
	await seedGoals('powerlifting', 'muay_thai');
	await gotoHydrated(page, '/profile/experience');
	await editorReady(page);
	const powerlifting = await sheetOf(page, 'Powerlifting');
	await level(powerlifting, 'Intermediate').check();
	// The level's hint sits at its row's end.
	await expect(powerlifting.getByText('Steady, structured training')).toBeVisible();
	// Years take a decimal point on the phone's keypad; sessions are whole numbers.
	await expect(years(powerlifting)).toHaveAttribute('inputmode', 'decimal');
	await expect(sessions(powerlifting)).toHaveAttribute('inputmode', 'numeric');
	await years(powerlifting).fill('2.5');
	await sessions(powerlifting).fill('4');
	await closeSheet(page, powerlifting);
	await expect(entry(page, 'Powerlifting')).toHaveAccessibleName(/^Powerlifting\s*Intermediate/);
	const muayThai = await sheetOf(page, 'Muay Thai');
	await level(muayThai, 'Novice').check();
	await sessions(muayThai).fill('2');
	await closeSheet(page, muayThai);

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
	await expect(entry(page, 'Muay Thai')).toHaveAccessibleName(/^Muay Thai\s*Novice/);
	const powerliftingAgain = await sheetOf(page, 'Powerlifting');
	await expect(level(powerliftingAgain, 'Intermediate')).toBeChecked();
	await expect(years(powerliftingAgain)).toHaveValue('2.5');
	await expect(sessions(powerliftingAgain)).toHaveValue('4');
	await closeSheet(page, powerliftingAgain);
	const muayThaiAgain = await sheetOf(page, 'Muay Thai');
	await expect(level(muayThaiAgain, 'Novice')).toBeChecked();
	await expect(years(muayThaiAgain)).toHaveValue('');
	await expect(sessions(muayThaiAgain)).toHaveValue('2');
	await closeSheet(page, muayThaiAgain);

	// Nothing unsaved: leaving asks nothing.
	await page.getByTestId('back-to-profile').click();
	await expect(page).toHaveURL('/profile');
});

test('a discipline is added from a sheet that arrow keys never add from, and a custom one needs a name', async ({
	page
}) => {
	await seedGoals('powerlifting');
	await gotoHydrated(page, '/profile/experience');
	await editorReady(page);
	await expect(titles(page)).toHaveText(['Powerlifting']);

	// Every discipline not listed yet, by its short name, and one of your own last.
	await page.getByTestId('add-discipline').click();
	const adding = page.getByRole('dialog', { name: 'What else do you train?' });
	await expect(adding.getByRole('radio', { name: 'Powerlifting', exact: true })).toHaveCount(0);
	await expect(adding.locator('label').last()).toHaveText('Something else');
	// Arrow keys step through it and add nothing.
	const running = adding.getByRole('radio', { name: 'Running', exact: true });
	await running.focus();
	for (const key of ['ArrowDown', 'ArrowUp']) {
		await page.keyboard.press(key);
	}
	await expect(running).toBeFocused();
	await expect(adding).toBeVisible();
	await expect(titles(page)).toHaveText(['Powerlifting']);

	// Enter adds the one in focus: the question goes, and the new one's sheet asks its level.
	await page.keyboard.press('Enter');
	await expect(adding).toBeHidden();
	const runningSheet = page.getByRole('dialog', { name: 'Running', exact: true });
	await expect(runningSheet).toBeVisible();
	await expect(titles(page)).toHaveText(['Powerlifting', 'Running']);
	await expect(page.getByRole('status').filter({ hasText: 'Added Running' })).toHaveCount(1);
	await level(runningSheet, 'Novice').check();
	await closeSheet(page, runningSheet);
	// Closed, the sheet hands the focus to the new row.
	await expect(entry(page, 'Running')).toBeFocused();
	await page.getByTestId('add-discipline').click();
	await expect(adding.getByRole('radio', { name: 'Running', exact: true })).toHaveCount(0);
	await closeSheet(page, adding);

	const own = await addDiscipline(page, 'Something else', 'Something else');
	await level(own, 'New').check();
	await closeSheet(page, own);
	await setLevel(page, entry(page, 'Powerlifting'), 'Advanced');
	await page.getByTestId('save-section').click();
	await expect(entry(page, 'Something else')).toHaveAccessibleDescription('Name this discipline');
	await expect(entry(page, 'Something else')).toBeFocused();
	expect(await rows()).toEqual([]);

	const named = await sheetOf(page, 'Something else');
	await expect(named.getByRole('alert')).toHaveText('Name this discipline');
	await named.getByRole('textbox', { name: 'What is it?' }).fill('Climbing');
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);
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

test('removing a row in the middle leaves the others as they were, errors included', async ({
	page,
	request
}) => {
	await seedGoals('powerlifting', 'muay_thai');
	await profileAction(request, '/profile/experience?/save', {
		entries: [{ discipline: 'running', level: 'intermediate', years: 3, sessionsPerWeek: 4 }]
	});
	await gotoHydrated(page, '/profile/experience');
	await editorReady(page);
	// What was saved first, then a blank row for each goal discipline without one.
	await expect(titles(page)).toHaveText(['Running', 'Powerlifting', 'Muay Thai']);
	const muayThai = await sheetOf(page, 'Muay Thai');
	await level(muayThai, 'Advanced').check();
	await years(muayThai).fill('6');
	await closeSheet(page, muayThai);
	await page.getByTestId('save-section').click();
	await expect(entry(page, 'Powerlifting')).toHaveAccessibleDescription('Pick your level');

	// The row below stays the same element, so nothing in it moves.
	await entry(page, 'Muay Thai').evaluate((el) => el.setAttribute('data-kept', ''));
	const powerlifting = await sheetOf(page, 'Powerlifting');
	await powerlifting.getByRole('button', { name: 'Remove Powerlifting' }).focus();
	await page.keyboard.press('Enter');
	await expect(powerlifting).toBeHidden();
	await expect(titles(page)).toHaveText(['Running', 'Muay Thai']);
	await expect(entry(page, 'Muay Thai')).toHaveAttribute('data-kept', '');
	// Its error left with it, and the focus took its place.
	await expect(page.locator('[data-testid="experience-entry"][aria-invalid]')).toHaveCount(0);
	await expect(page.locator(':focus')).toHaveAttribute(
		'data-testid',
		/experience-entry|add-discipline/
	);
	await expect(page.getByRole('status').filter({ hasText: 'Removed Powerlifting' })).toHaveCount(1);
	await expect(entry(page, 'Running')).toHaveAccessibleName(/^Running\s*Intermediate/);
	await expect(entry(page, 'Muay Thai')).toHaveAccessibleName(/^Muay Thai\s*Advanced/);
	const runningSheet = await sheetOf(page, 'Running');
	await expect(years(runningSheet)).toHaveValue('3');
	await expect(sessions(runningSheet)).toHaveValue('4');
	await closeSheet(page, runningSheet);

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
	await expect(entry(page, 'Powerlifting')).toHaveAccessibleName(/^Powerlifting\s*Choose/);
});

test('with nothing in play there are no rows, only the way to add one, and it comes back to that', async ({
	page
}, testInfo) => {
	await gotoHydrated(page, '/profile/experience');
	await editorReady(page);
	const add = page.getByTestId('add-discipline');
	await expect(page.getByTestId('experience-entry')).toHaveCount(0);
	await expect(add).toHaveText('Add something else you train');
	await captureScreen(page, testInfo, 'profile-experience-empty');

	const muayThai = await addDiscipline(page, 'Muay Thai', 'Muay Thai');
	await expect(page.getByTestId('experience-entry')).toHaveCount(1);
	await muayThai.getByRole('button', { name: 'Remove Muay Thai' }).click();
	await expect(muayThai).toBeHidden();
	await expect(page.getByTestId('experience-entry')).toHaveCount(0);
	await expect(add).toBeFocused();
	// The row went without a trace on screen: a screen reader hears it.
	await expect(page.getByRole('status').filter({ hasText: 'Removed Muay Thai' })).toHaveCount(1);
});

for (const theme of ['dark', 'light'] as const) {
	test(`rows, their errors, a custom discipline and its sheet have no WCAG A/AA violations (${theme})`, async ({
		page
	}, testInfo) => {
		await page.addInitScript(
			(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
			theme
		);
		await seedGoals('powerlifting', 'muay_thai');
		await gotoHydrated(page, '/profile/experience');
		await editorReady(page);
		if (theme === 'light')
			await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await setLevel(page, entry(page, 'Powerlifting'), 'Intermediate');
		await closeSheet(page, await addDiscipline(page, 'Something else', 'Something else'));
		await page.getByTestId('save-section').click();
		await expect(entry(page, 'Muay Thai')).toHaveAttribute('aria-invalid', 'true');
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(400);
		const audit = async () =>
			(
				await new AxeBuilder({ page })
					.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
					.analyze()
			).violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
		expect(await audit(), 'rows').toEqual([]);
		await captureScreen(page, testInfo, `profile-experience-errors-${theme}`);

		// A custom discipline's sheet, with its name field and its errors.
		const own = await sheetOf(page, 'Something else');
		await expect(own.getByRole('alert').first()).toBeVisible();
		await page.waitForTimeout(400);
		expect(await audit(), 'sheet').toEqual([]);
	});
}
