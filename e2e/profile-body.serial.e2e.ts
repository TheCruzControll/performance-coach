/**
 * Profile → Body & nutrition: today's body weight (a dated history), birth year, the nutrition
 * phase and a weight target. Serial (one test at a time, after the functional suites): every test
 * starts from a blank training profile, which every browser and worker shares.
 */
import { expect, test, type Page } from '@playwright/test';
import {
	captureScreen,
	gotoHydrated,
	openSheet,
	pick,
	profileAction,
	query,
	resetTrainingProfile,
	toastWith,
	trackConsoleErrors
} from './support';

/** The owner's weigh-ins, oldest first; `today` is the owner's calendar day in their zone. */
const weighIns = () =>
	query(
		`select b.value::float8 as value, b.unit, b.source,
		        b.measured_on = (now() at time zone p.time_zone)::date as today
		 from body_weight_entries b join athlete_profiles p using (owner_id) order by b.id`
	);

const profile = () =>
	query(
		`select birth_year, nutrition_phase, target_weight::float8 as target_weight,
		        target_weight_unit, target_date::text as target_date
		 from athlete_profiles`
	);

/** What Save posts for a profile with nothing but this phase (and kg). */
const body = (overrides: Record<string, unknown> = {}) => ({
	birthYear: null,
	weightUnit: 'kg',
	bodyWeight: null,
	nutritionPhase: null,
	targetWeight: null,
	targetDate: null,
	...overrides
});

/** The editor has loaded under the title. */
async function editorReady(page: Page) {
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
}

const weight = (page: Page) => page.getByRole('textbox', { name: /^Body weight/ });
/** The Nutrition phase row: its question, then its answer. */
const phaseRow = (page: Page) => page.getByTestId('nutrition-phase');
/** Pick a phase from the row's sheet; the sheet closes. */
const setPhase = (page: Page, name: string | RegExp) => pick(page, page, 'Nutrition phase', name);

async function save(page: Page) {
	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
}

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test('today’s weight is recorded once a day from Profile, and re-saving replaces it', async ({
	page
}) => {
	const errors = trackConsoleErrors(page);
	await gotoHydrated(page, '/profile');
	await page.getByTestId('section-body').click();
	await expect(page).toHaveURL('/profile/body');
	await expect(page.getByRole('heading', { level: 1, name: 'Body and nutrition' })).toBeVisible();
	await editorReady(page);
	// A blank profile: no weight yet, and no phase is "Not focusing on it".
	await expect(weight(page)).toHaveValue('');
	await expect(weight(page)).toHaveAttribute('inputmode', 'decimal');
	await expect(phaseRow(page)).toHaveAccessibleName(/^Nutrition phase\s*Not focusing on it$/);

	await weight(page).fill('82.4');
	await save(page);
	expect(await weighIns()).toEqual([{ value: 82.4, unit: 'kg', source: 'profile', today: true }]);

	// Later the same day: the field starts from that weigh-in, and a new one replaces it.
	await page.reload();
	await editorReady(page);
	await expect(weight(page)).toHaveValue('82.4');
	await weight(page).fill('82.1');
	await save(page);
	expect(await weighIns()).toEqual([{ value: 82.1, unit: 'kg', source: 'profile', today: true }]);

	await page.reload();
	await editorReady(page);
	await expect(weight(page)).toHaveValue('82.1');
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth
	}));
	expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
	expect(errors).toEqual([]);
});

test('a cut to 78 kg by a date, with a birth year, is stored on the profile', async ({
	page
}, testInfo) => {
	await gotoHydrated(page, '/profile/body');
	await editorReady(page);
	// Birth year and the target each open a short sheet of fields; Escape keeps what was typed.
	const year = await openSheet(page, page, 'Birth year');
	await year.getByRole('textbox', { name: /^Birth year/ }).fill('1994');
	await page.keyboard.press('Escape');
	await expect(year).toBeHidden();
	await expect(page.getByTestId('birth-year-row')).toHaveAccessibleName(/^Birth year\s*1994$/);
	await setPhase(page, /^Cut/);
	const target = await openSheet(page, page, 'Target weight');
	await target.getByRole('textbox', { name: /^Target weight/ }).fill('78');
	await target.getByLabel(/^By when/).fill('2027-06-30');
	await page.keyboard.press('Escape');
	await expect(target).toBeHidden();
	// The year is said unless it is this one (the device's date).
	const thisYear = await page.evaluate(() => new Date().getFullYear());
	await expect(page.getByTestId('target-weight-row')).toHaveAccessibleName(
		new RegExp(`^Target weight\\s*78 kg by 30 June${thisYear === 2027 ? '' : ' 2027'}$`)
	);
	await save(page);
	expect(await profile()).toEqual([
		{
			birth_year: 1994,
			nutrition_phase: 'cut',
			target_weight: 78,
			target_weight_unit: 'kg',
			target_date: '2027-06-30'
		}
	]);
	// No weight typed: no weigh-in.
	expect(await weighIns()).toEqual([]);
	await page.evaluate(() => scrollTo(0, 0));
	await captureScreen(page, testInfo, 'profile-body');

	await page.reload();
	await page.waitForLoadState('networkidle');
	await editorReady(page);
	await expect(phaseRow(page)).toHaveAccessibleName(/^Nutrition phase\s*Cut/);
	const yearAgain = await openSheet(page, page, 'Birth year');
	await expect(yearAgain.getByRole('textbox', { name: /^Birth year/ })).toHaveValue('1994');
	await page.keyboard.press('Escape');
	await expect(yearAgain).toBeHidden();
	const targetAgain = await openSheet(page, page, 'Target weight');
	await expect(targetAgain.getByRole('textbox', { name: /^Target weight/ })).toHaveValue('78');
	await expect(targetAgain.getByLabel(/^By when/)).toHaveValue('2027-06-30');
	await page.keyboard.press('Escape');
	await expect(targetAgain).toBeHidden();
});

test('the nutrition phase is a row that opens a sheet of five, and a pick closes it', async ({
	page
}) => {
	await gotoHydrated(page, '/profile/body');
	await editorReady(page);
	// A blank profile: "Not focusing on it" is the answer (no phase in the data).
	await expect(phaseRow(page)).toHaveAccessibleName(/^Nutrition phase\s*Not focusing on it$/);
	await expect(phaseRow(page)).toHaveAttribute('aria-haspopup', 'dialog');
	// From the keyboard, so every engine has the row focused (WebKit focuses no button on a click).
	await phaseRow(page).focus();
	await page.keyboard.press('Enter');
	const sheet = page.getByRole('dialog', { name: 'Nutrition phase' });
	await expect(sheet).toBeVisible();
	await expect(sheet).toContainText('It informs your training. It never overrides it.');
	await expect(sheet.getByRole('radio')).toHaveCount(5);
	await expect(sheet.getByRole('radio', { name: /Not focusing on it/ })).toBeChecked();
	await sheet.getByRole('radio', { name: /^Bulk/ }).click();
	await expect(sheet).toBeHidden();
	await expect(phaseRow(page)).toHaveAccessibleName(/^Nutrition phase\s*Bulk/);
	// The sheet hands the focus back to its row.
	await expect(phaseRow(page)).toBeFocused();
});

test('from the keyboard, arrows move the phase with the sheet open, and Space picks and closes it', async ({
	page
}) => {
	await gotoHydrated(page, '/profile/body');
	await editorReady(page);
	// From the keyboard, so every engine has the row focused (WebKit focuses no button on a click).
	await phaseRow(page).focus();
	await page.keyboard.press('Enter');
	const sheet = page.getByRole('dialog', { name: 'Nutrition phase' });
	await expect(sheet).toBeVisible();
	const radio = (name: RegExp) => sheet.getByRole('radio', { name });
	// Tab past the sheet's Close (and its body, when that scrolls) to the picked answer.
	const none = radio(/Not focusing on it/);
	for (let step = 0; step < 4; step++) {
		await page.keyboard.press('Tab');
		if (await none.evaluate((el) => el === document.activeElement)) break;
	}
	await expect(none).toBeFocused();

	// Two steps up: Recomp, then Maintenance, and the sheet stays open for each.
	await page.keyboard.press('ArrowUp');
	await expect(radio(/^Recomp/)).toBeChecked();
	await expect(radio(/^Recomp/)).toBeFocused();
	await page.keyboard.press('ArrowUp');
	await expect(radio(/^Maintenance/)).toBeChecked();
	await expect(radio(/^Maintenance/)).toBeFocused();
	await expect(sheet).toBeVisible();
	await expect(phaseRow(page)).toHaveAccessibleName(/^Nutrition phase\s*Maintenance/);

	// Space picks the focused answer: the sheet closes and hands the focus back to its row.
	await page.keyboard.press('Space');
	await expect(sheet).toBeHidden();
	await expect(phaseRow(page)).toBeFocused();
	await expect(phaseRow(page)).toHaveAccessibleName(/^Nutrition phase\s*Maintenance/);
});

test('“Not focusing on it” stores no phase, and is still picked after a reload', async ({
	page,
	request
}) => {
	await profileAction(request, '/profile/body?/save', body({ nutritionPhase: 'bulk' }));
	await gotoHydrated(page, '/profile/body');
	await editorReady(page);
	await expect(phaseRow(page)).toHaveAccessibleName(/^Nutrition phase\s*Bulk/);
	await setPhase(page, /Not focusing on it/);
	await save(page);
	expect(await profile()).toMatchObject([{ nutrition_phase: null }]);

	await page.reload();
	await page.waitForLoadState('networkidle');
	await editorReady(page);
	await expect(phaseRow(page)).toHaveAccessibleName(/^Nutrition phase\s*Not focusing on it$/);
	await phaseRow(page).click();
	const sheet = page.getByRole('dialog', { name: 'Nutrition phase' });
	await expect(sheet.getByRole('radio', { name: /Not focusing on it/ })).toBeChecked();
	await expect(sheet.getByRole('radio', { name: /^Bulk/ })).not.toBeChecked();
});

test('a weight recorded in kg shows in lb, and saving it untouched records no weigh-in', async ({
	page,
	request
}) => {
	await profileAction(request, '/profile/body?/save', body({ bodyWeight: 82.4 }));
	// The coach's units switched to lb since (Profile → basics).
	await query(`update athlete_profiles set weight_unit = 'lb'`);
	await gotoHydrated(page, '/profile/body');
	await editorReady(page);
	await expect(weight(page)).toHaveValue('181.7');
	await expect(page.getByText('Converted from 82.4 kg')).toBeVisible();

	await setPhase(page, /^Maintenance/);
	await save(page);
	expect(await profile()).toMatchObject([{ nutrition_phase: 'maintenance' }]);
	expect(await weighIns()).toEqual([{ value: 82.4, unit: 'kg', source: 'profile', today: true }]);
});

test('a 400 kg body weight and a birth year out of range are refused, field by field', async ({
	page
}) => {
	await gotoHydrated(page, '/profile/body');
	await editorReady(page);
	await weight(page).fill('400');
	const sheet = await openSheet(page, page, 'Birth year');
	const year = sheet.getByRole('textbox', { name: /^Birth year/ });
	await year.fill('1890');
	await page.keyboard.press('Escape');
	await expect(sheet).toBeHidden();
	await page.getByTestId('save-section').click();

	const field = (box: ReturnType<typeof weight>) =>
		page.locator('.field').filter({ has: box }).getByRole('alert');
	await expect(field(weight(page))).toHaveText('Between 25 and 350 kg');
	await expect(weight(page)).toHaveAttribute('aria-invalid', 'true');
	await expect(weight(page)).toBeFocused();
	// The year's error is one red line under its row, which is marked invalid and says why.
	const yearRow = page.getByTestId('birth-year-row');
	await expect(yearRow).toHaveAttribute('aria-invalid', 'true');
	await expect(yearRow).toHaveAccessibleDescription(/^A year between \d{4} and \d{4}$/);
	await expect(
		page
			.locator('.sheet-row')
			.filter({ has: yearRow })
			.getByText(/^A year between \d{4} and \d{4}$/)
	).toBeVisible();
	// Opened, the sheet shows the field with the same error.
	await yearRow.click();
	await expect(sheet.getByRole('alert')).toHaveText(/^A year between \d{4} and \d{4}$/);
	await expect(year).toHaveAttribute('aria-invalid', 'true');
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('save-error')).toContainText('Check the highlighted fields');
	expect(await weighIns()).toEqual([]);
	expect(await profile()).toMatchObject([{ birth_year: null }]);
});
