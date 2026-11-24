/**
 * Profile → Strength: optional 1RMs, each measured or estimated, or "I don't know my numbers".
 * A lift is a row with its value, opening a sheet of its fields.
 * Serial (one test at a time, after the functional suites): every test starts from a blank
 * training profile, which every browser and worker shares.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { estimateOneRepMax } from '../src/lib/domain/e1rm';
import { roundEstimate } from '../src/lib/domain/units';
import {
	captureScreen,
	gotoHydrated,
	openSheet,
	profileAction,
	query,
	resetTrainingProfile,
	toastWith,
	trackConsoleErrors
} from './support';

/** The editor has loaded under the title. */
async function editorReady(page: Page) {
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
}

/** A lift's row, by its name: its accessible name is the name, then what is known of it. */
const liftRow = (page: Page, name: string) =>
	page.getByTestId('baseline-lift').filter({ hasText: name });

/** "Add a lift": pick it from the sheet, which closes, and the lift's own sheet opens. */
async function addLift(page: Page, name: string): Promise<Locator> {
	await page.getByTestId('add-lift').click();
	const adding = page.getByRole('dialog', { name: 'Add a lift' });
	await adding.getByRole('radio', { name, exact: true }).click();
	await expect(adding).toBeHidden();
	const sheet = page.getByRole('dialog', { name, exact: true });
	await expect(sheet).toBeVisible();
	return sheet;
}

/** Close a lift's sheet with Escape: what was typed stays, and its row says it. */
async function closeSheet(page: Page, sheet: Locator) {
	await page.keyboard.press('Escape');
	await expect(sheet).toBeHidden();
}

/** Every field stays inside its sheet: a date input is never squeezed past a phone's edge. */
async function fieldsInside(sheet: Locator) {
	const { x, width } = (await sheet.locator('.sheet').boundingBox())!;
	for (const field of await sheet.locator('input:not([type=radio])').all()) {
		const box = (await field.boundingBox())!;
		expect(box.x + box.width, await field.evaluate((el) => el.id)).toBeLessThanOrEqual(x + width);
	}
}

/** The owner's current (not superseded) baselines, as stored. */
const currentLifts = () =>
	query(
		`select lift, custom_label, kind, source, value::float8 as value, unit,
			achieved_on::text as achieved_on, set_weight::float8 as set_weight, set_reps,
			set_rpe::float8 as set_rpe, method, confidence
		from strength_baselines where superseded_at is null order by lift`
	);

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test('“I don’t know my numbers” makes the section one statement and stores no lifts', async ({
	page
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	await gotoHydrated(page, '/profile');
	const row = page.getByTestId('section-strength');
	await expect(row).toHaveAttribute('href', '/profile/strength');
	await row.click();
	await expect(page).toHaveURL('/profile/strength');
	await expect(page.getByRole('heading', { level: 1, name: 'Strength' })).toBeVisible();
	await editorReady(page);
	// Paper, 9 · "Strength": the lede, no lifts yet, Add a lift, and the way out of knowing.
	await expect(page.getByText('Your best lifts. Add only what you know.')).toBeVisible();
	await expect(page.getByTestId('baseline-lift')).toHaveCount(0);
	await expect(page.getByTestId('add-lift')).toHaveText('Add a lift');

	const explainer = page.getByTestId('baselines-explainer');
	const unknown = page.getByTestId('baselines-unknown');
	await expect(unknown).toHaveAccessibleName('I don’t know my numbers');
	await expect(explainer).toHaveCount(0);
	await unknown.click();
	await expect(
		explainer.getByRole('heading', { level: 2, name: 'Week one finds your numbers' })
	).toBeVisible();
	await expect(explainer).toContainText('No maxing out');
	await expect(explainer).toContainText('how hard it felt');
	// "I don't know" is the whole answer: nothing to add, and one row to turn it round, focused.
	await expect(page.getByTestId('add-lift')).toHaveCount(0);
	await expect(page.getByTestId('baselines-known')).toBeFocused();
	await captureScreen(page, testInfo, 'profile-strength-unknown');

	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	expect(await query('select baselines_unknown from athlete_profiles')).toEqual([
		{ baselines_unknown: true }
	]);
	expect(await query('select count(*)::int as n from strength_baselines')).toEqual([{ n: 0 }]);

	await page.reload();
	await editorReady(page);
	await expect(explainer).toBeVisible();
	await expect(page.getByTestId('baselines-known')).toBeVisible();
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth
	}));
	expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
	expect(errors).toEqual([]);
});

test('a tested squat is stored as measured and a bench from a set as estimated, apart after a reload', async ({
	page
}, testInfo) => {
	await gotoHydrated(page, '/profile/strength');
	await editorReady(page);
	const squat = await addLift(page, 'Back squat');
	// How you know it comes first: the number's field comes with the answer.
	await expect(squat.getByRole('textbox', { name: '1RM' })).toHaveCount(0);
	await squat.getByRole('radio', { name: 'Tested max' }).check();
	await squat.getByRole('textbox', { name: '1RM' }).fill('140');
	await squat.getByLabel('When').fill('2026-10-12');
	await closeSheet(page, squat);
	// The sheet hands the focus back to its new row, which says what was typed.
	await expect(liftRow(page, 'Back squat')).toBeFocused();
	await expect(liftRow(page, 'Back squat')).toHaveAccessibleName(/^Back squat\s*140 kg/);
	// Added, it leaves the list of lifts to add.
	await page.getByTestId('add-lift').click();
	const adding = page.getByRole('dialog', { name: 'Add a lift' });
	await expect(adding.getByRole('radio', { name: 'Back squat', exact: true })).toHaveCount(0);
	await closeSheet(page, adding);

	const bench = await addLift(page, 'Bench press');
	await bench.getByRole('radio', { name: 'From a recent set' }).check();
	await expect(bench.getByRole('textbox', { name: '1RM' })).toHaveCount(0);
	await expect(bench.getByRole('group', { name: 'A recent hard set' })).toBeVisible();
	await expect(bench.getByTestId('baseline-estimate')).toHaveText(
		'Enter a recent hard set. RPE is how hard it felt: 10 is nothing left.'
	);
	await bench.getByRole('textbox', { name: 'Weight' }).fill('100');
	await bench.getByRole('textbox', { name: 'Reps' }).fill('5');
	await bench.getByRole('textbox', { name: 'RPE' }).fill('8');
	// Worked out live with the function the server stores it with (to the hundredth it keeps),
	// and shown as an estimate is: to the nearest 0.5 kg, never to the hundredth.
	const e1rm = estimateOneRepMax({ weight: 100, reps: 5, rpe: 8 })!;
	const stored = Math.round(e1rm.value * 100) / 100;
	const shown = roundEstimate(e1rm.value, 'kg');
	expect(shown % 0.5).toBe(0);
	const estimate = `I estimate your best single at about ${shown} kg.`;
	await expect(bench.getByTestId('baseline-estimate')).toHaveText(estimate);
	await closeSheet(page, bench);
	await expect(liftRow(page, 'Bench press')).toHaveAccessibleName(/^Bench press\s*100 kg × 5/);

	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	expect(await currentLifts()).toEqual([
		{
			lift: 'back_squat',
			custom_label: '',
			kind: 'measured',
			source: 'tested',
			value: 140,
			unit: 'kg',
			achieved_on: '2026-10-12',
			set_weight: null,
			set_reps: null,
			set_rpe: null,
			method: null,
			confidence: null
		},
		{
			lift: 'bench_press',
			custom_label: '',
			kind: 'estimated',
			source: 'set',
			value: stored,
			unit: 'kg',
			achieved_on: null,
			set_weight: 100,
			set_reps: 5,
			set_rpe: 8,
			method: 'rpe-table',
			confidence: e1rm.confidence
		}
	]);
	expect(await query('select baselines_unknown from athlete_profiles')).toEqual([
		{ baselines_unknown: false }
	]);

	await page.reload();
	await editorReady(page);
	await expect(liftRow(page, 'Back squat')).toHaveAccessibleName(/^Back squat\s*140 kg/);
	await expect(liftRow(page, 'Bench press')).toHaveAccessibleName(/^Bench press\s*100 kg × 5/);
	const squatAgain = await openSheet(page, page, /^Back squat/, 'Back squat');
	await expect(squatAgain.getByRole('radio', { name: 'Tested max' })).toBeChecked();
	await expect(squatAgain.getByRole('textbox', { name: '1RM' })).toHaveValue('140');
	await expect(squatAgain.getByLabel('When')).toHaveValue('2026-10-12');
	await fieldsInside(squatAgain);
	await closeSheet(page, squatAgain);
	const benchAgain = await openSheet(page, page, /^Bench press/, 'Bench press');
	await expect(benchAgain.getByRole('radio', { name: 'From a recent set' })).toBeChecked();
	// The computed 1RM is never offered as a max of the owner's: the set is what they edit.
	await expect(benchAgain.getByRole('textbox', { name: '1RM' })).toHaveCount(0);
	await expect(benchAgain.getByRole('textbox', { name: 'Weight' })).toHaveValue('100');
	await expect(benchAgain.getByRole('textbox', { name: 'Reps' })).toHaveValue('5');
	await expect(benchAgain.getByRole('textbox', { name: 'RPE' })).toHaveValue('8');
	await expect(benchAgain.getByTestId('baseline-estimate')).toHaveText(estimate);
	await fieldsInside(benchAgain);
	await captureScreen(page, testInfo, 'profile-strength');
	await closeSheet(page, benchAgain);
});

test('a lift left blank shows its error until it is removed, and 600 kg is out of range', async ({
	page
}) => {
	await gotoHydrated(page, '/profile/strength');
	await editorReady(page);
	await closeSheet(page, await addLift(page, 'Deadlift'));
	const squat = await addLift(page, 'Back squat');
	await squat.getByRole('radio', { name: 'Tested max' }).check();
	await squat.getByRole('textbox', { name: '1RM' }).fill('600');
	await closeSheet(page, squat);
	const save = page.getByTestId('save-section');
	await save.click();
	// Each row with a problem says it in one red line, and the first takes the focus.
	const deadliftRow = liftRow(page, 'Deadlift');
	const squatRow = liftRow(page, 'Back squat');
	await expect(deadliftRow).toHaveAttribute('aria-invalid', 'true');
	await expect(deadliftRow).toHaveAccessibleDescription('How do you know this number?');
	await expect(squatRow).toHaveAccessibleDescription('1RM between 1 and 500 kg');
	await expect(deadliftRow).toBeFocused();
	// Opened, the sheet shows the message on its field.
	const squatAgain = await openSheet(page, page, /^Back squat/, 'Back squat');
	const squatMax = squatAgain.getByRole('textbox', { name: '1RM' });
	await expect(squatMax).toHaveAttribute('aria-invalid', 'true');
	await expect(squatAgain.getByRole('alert')).toHaveText('1RM between 1 and 500 kg');

	await squatMax.fill('200');
	await closeSheet(page, squatAgain);
	await save.click();
	await expect(page.getByTestId('save-error')).toBeVisible();
	await expect(squatRow).not.toHaveAttribute('aria-invalid');
	await expect(deadliftRow).toHaveAccessibleDescription('How do you know this number?');
	expect(await query('select count(*)::int as n from strength_baselines')).toEqual([{ n: 0 }]);

	// Removed from its sheet: the row goes, the sheet with it, and the focus takes its place.
	// The next lift keeps its place on screen, its value and none of the removed lift's error.
	await squatRow.evaluate((el) => el.setAttribute('data-was-here', ''));
	const deadlift = await openSheet(page, page, /^Deadlift/, 'Deadlift');
	await deadlift.getByRole('button', { name: 'Remove this lift' }).focus();
	await page.keyboard.press('Enter');
	await expect(deadlift).toBeHidden();
	await expect(page.getByTestId('baseline-lift')).toHaveCount(1);
	await expect(page.locator(':focus')).toHaveAttribute('data-testid', /baseline-lift|add-lift/);
	await expect(page.getByRole('status').filter({ hasText: 'Removed Deadlift' })).toHaveCount(1);
	await expect(squatRow).toHaveAttribute('data-was-here', '');
	await expect(squatRow).not.toHaveAttribute('aria-invalid');
	await expect(squatRow).toHaveAccessibleName(/^Back squat\s*200 kg/);

	await save.click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	expect(await currentLifts()).toMatchObject([
		{ lift: 'back_squat', kind: 'measured', source: 'tested', value: 200 }
	]);
});

test('Add a lift lists the disciplines’ lifts first, then the rest, then one of your own', async ({
	page
}) => {
	// Weightlifting experience: its lifts are offered first.
	await query(
		`insert into discipline_experience (owner_id, discipline, level)
		select id, 'weightlifting', 'intermediate' from owners`
	);
	await gotoHydrated(page, '/profile/strength');
	await editorReady(page);
	await page.getByTestId('add-lift').click();
	const adding = page.getByRole('dialog', { name: 'Add a lift' });
	// One list that scrolls: no "More lifts".
	await expect(adding.locator('label')).toHaveText([
		'Snatch',
		'Clean & jerk',
		'Front squat',
		'Back squat',
		'Bench press',
		'Deadlift',
		'Overhead press',
		'Power clean',
		'Weighted pull-up',
		'Other lift'
	]);
	// Arrow keys step through it and add nothing; the sheet stays until a pick or Escape.
	await adding.getByRole('radio', { name: 'Snatch' }).focus();
	for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp']) {
		await page.keyboard.press(key);
	}
	await expect(adding.getByRole('radio', { name: 'Clean & jerk' })).toBeFocused();
	await expect(adding).toBeVisible();
	await expect(page.getByTestId('baseline-lift')).toHaveCount(0);
	await closeSheet(page, adding);
	await expect(page.getByTestId('baseline-lift')).toHaveCount(0);

	const own = await addLift(page, 'Other lift');
	await own.getByRole('radio', { name: 'My best guess' }).check();
	await own.getByRole('textbox', { name: '1RM' }).fill('90');
	await closeSheet(page, own);
	// A best guess says so in the row's words: "About".
	const row = page.getByTestId('baseline-lift');
	await expect(row).toHaveAccessibleName(/^Other lift\s*About 90 kg/);
	await page.getByTestId('save-section').click();
	await expect(row).toHaveAccessibleDescription('Name the lift');
	const named = await openSheet(page, page, /^Other lift/, 'Other lift');
	await expect(named.getByRole('alert')).toHaveText('Name the lift');
	await named.getByRole('textbox', { name: 'Lift name' }).fill('Zercher squat');
	// The sheet and its row take the name as it is typed.
	await expect(page.getByRole('dialog', { name: 'Zercher squat' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toHaveCount(0);
	await expect(row).toHaveAccessibleName(/^Zercher squat\s*About 90 kg/);
	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	expect(await currentLifts()).toMatchObject([
		{
			lift: 'custom',
			custom_label: 'Zercher squat',
			kind: 'estimated',
			source: 'estimate',
			value: 90
		}
	]);
});

test('switching back to “I don’t know” sets the saved lifts aside and keeps their history', async ({
	page,
	request
}) => {
	await profileAction(request, '/profile/strength?/save', {
		unknown: false,
		lifts: [
			{ lift: 'back_squat', source: 'tested', value: 140, unit: 'kg', achievedOn: '2026-10-12' },
			{ lift: 'bench_press', source: 'set', unit: 'kg', setWeight: 100, setReps: 5, setRpe: 8 }
		]
	});
	await gotoHydrated(page, '/profile/strength');
	await editorReady(page);
	await expect(page.getByTestId('baseline-lift')).toHaveCount(2);
	await page.getByTestId('baselines-unknown').click();
	await expect(page.getByTestId('baseline-lift')).toHaveCount(0);
	await expect(page.getByTestId('baselines-explainer')).toContainText(
		'any you saved before stay in your history'
	);
	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	expect(await query('select baselines_unknown from athlete_profiles')).toEqual([
		{ baselines_unknown: true }
	]);
	expect(
		await query(
			`select lift, kind, superseded_at is not null as superseded
			from strength_baselines order by lift`
		)
	).toEqual([
		{ lift: 'back_squat', kind: 'measured', superseded: true },
		{ lift: 'bench_press', kind: 'estimated', superseded: true }
	]);

	// After a reload the lifts are history: "I know some of my lifts" starts from none.
	await page.reload();
	await editorReady(page);
	await expect(page.getByTestId('baselines-explainer')).toBeVisible();
	await page.getByTestId('baselines-known').click();
	await expect(page.getByTestId('baseline-lift')).toHaveCount(0);
	await expect(page.getByTestId('add-lift')).toBeVisible();
	await expect(page.getByTestId('baselines-unknown')).toBeFocused();
});
