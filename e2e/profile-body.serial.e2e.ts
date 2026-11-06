/**
 * Profile → Body & nutrition: today's body weight (a dated history), birth year, the nutrition
 * phase and a weight target. Serial (one test at a time, after the functional suites): every test
 * starts from a blank training profile, which every browser and worker shares.
 */
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

/** The editor has loaded in place of the skeleton. */
async function editorReady(page: Page) {
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
}

const weight = (page: Page) => page.getByRole('textbox', { name: /^Body weight/ });
const phase = (page: Page, name: string | RegExp) =>
	page.getByRole('group', { name: 'Nutrition phase' }).getByRole('radio', { name });

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
	await page
		.getByRole('region', { name: 'Training profile' })
		.getByRole('link', { name: /Body & nutrition/ })
		.click();
	await expect(page).toHaveURL('/profile/body');
	await expect(page.getByRole('heading', { level: 1, name: 'Body & nutrition' })).toBeVisible();
	await editorReady(page);
	// A blank profile: no weight yet, and no phase is "Not focusing on it".
	await expect(weight(page)).toHaveValue('');
	await expect(weight(page)).toHaveAttribute('inputmode', 'decimal');
	await expect(phase(page, /Not focusing on it/)).toBeChecked();

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
	await page.goto('/profile/body');
	await editorReady(page);
	await page.getByRole('textbox', { name: /^Birth year/ }).fill('1994');
	await phase(page, /^Cut/).check();
	await page.getByRole('textbox', { name: /^Target weight/ }).fill('78');
	await page.getByLabel(/^By when/).fill('2027-06-30');
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
	await editorReady(page);
	await expect(page.getByRole('textbox', { name: /^Birth year/ })).toHaveValue('1994');
	await expect(phase(page, /^Cut/)).toBeChecked();
	await expect(page.getByRole('textbox', { name: /^Target weight/ })).toHaveValue('78');
	await expect(page.getByLabel(/^By when/)).toHaveValue('2027-06-30');
});

test('“Not focusing on it” stores no phase, and is still picked after a reload', async ({
	page,
	request
}) => {
	await profileAction(request, '/profile/body?/save', body({ nutritionPhase: 'bulk' }));
	await page.goto('/profile/body');
	await editorReady(page);
	await expect(phase(page, /^Bulk/)).toBeChecked();
	await phase(page, /Not focusing on it/).check();
	await save(page);
	expect(await profile()).toMatchObject([{ nutrition_phase: null }]);

	await page.reload();
	await editorReady(page);
	await expect(phase(page, /Not focusing on it/)).toBeChecked();
	await expect(phase(page, /^Bulk/)).not.toBeChecked();
});

test('a weight recorded in kg shows in lb, and saving it untouched records no weigh-in', async ({
	page,
	request
}) => {
	await profileAction(request, '/profile/body?/save', body({ bodyWeight: 82.4 }));
	// The coach's units switched to lb since (Profile → basics).
	await query(`update athlete_profiles set weight_unit = 'lb'`);
	await page.goto('/profile/body');
	await editorReady(page);
	await expect(weight(page)).toHaveValue('181.7');
	await expect(page.getByText('Converted from 82.4 kg')).toBeVisible();

	await phase(page, /^Maintenance/).check();
	await save(page);
	expect(await profile()).toMatchObject([{ nutrition_phase: 'maintenance' }]);
	expect(await weighIns()).toEqual([{ value: 82.4, unit: 'kg', source: 'profile', today: true }]);
});

test('a 400 kg body weight and a birth year out of range are refused, field by field', async ({
	page
}) => {
	await page.goto('/profile/body');
	await editorReady(page);
	const year = page.getByRole('textbox', { name: /^Birth year/ });
	await weight(page).fill('400');
	await year.fill('1890');
	await page.getByTestId('save-section').click();

	const field = (box: ReturnType<typeof weight>) =>
		page.locator('.field').filter({ has: box }).getByRole('alert');
	await expect(field(weight(page))).toHaveText('Between 25 and 350 kg');
	await expect(field(year)).toHaveText(/^A year between \d{4} and \d{4}$/);
	await expect(weight(page)).toHaveAttribute('aria-invalid', 'true');
	await expect(year).toHaveAttribute('aria-invalid', 'true');
	await expect(weight(page)).toBeFocused();
	await expect(page.getByTestId('save-error')).toContainText('Check the highlighted fields');
	expect(await weighIns()).toEqual([]);
	expect(await profile()).toMatchObject([{ birth_year: null }]);
});
