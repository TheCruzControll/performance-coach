/**
 * Profile → Name & units (/profile/basics): what the coach calls the owner and the units it plans
 * in. Serial (one test at a time, after the functional suites): every test starts from a blank
 * training profile, which every browser and worker shares.
 */
import { expect, test, type Page } from '@playwright/test';
import {
	captureScreen,
	gotoHydrated,
	query,
	resetTrainingProfile,
	toastWith,
	trackConsoleErrors
} from './support';

/** The editor has loaded in place of the skeleton. */
async function editorReady(page: Page) {
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
}

/** Whether `unit` is the one picked in the segmented control named `group`. */
const picked = (page: Page, group: string, unit: string) =>
	expect(
		page.getByRole('radiogroup', { name: group, exact: true }).getByRole('radio', { name: unit })
	).toHaveAttribute('aria-checked', 'true');

const nameField = (page: Page) =>
	page.getByRole('textbox', { name: 'What should your coach call you?' });

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test('a new name and lb, mi save and stay; Profile is headed by the name and the device follows', async ({
	page
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	// A saved time zone, which the editor must keep: it sends none.
	await query(
		`insert into athlete_profiles (owner_id, name, time_zone)
		 select id, display_name, 'America/Los_Angeles' from owners`
	);
	await gotoHydrated(page, '/profile');
	// Until the owner says otherwise, the coach uses the passkey owner's name, in kg and km.
	await expect(page.getByTestId('owner-name')).toHaveText('Niko Cruz');
	await picked(page, 'Units', 'kg');
	await picked(page, 'Distance', 'km');

	const row = page
		.getByRole('region', { name: 'Training profile' })
		.getByRole('link', { name: /Name & units/ });
	await expect(row).toHaveAttribute('href', '/profile/basics');
	await row.click();
	await expect(page).toHaveURL('/profile/basics');
	await expect(page.getByRole('heading', { level: 1, name: 'Name & units' })).toBeVisible();
	await editorReady(page);
	await expect(nameField(page)).toHaveValue('Niko Cruz');
	await picked(page, 'Weights in', 'kg');
	await picked(page, 'Distances in', 'km');

	await nameField(page).fill('Niko');
	await page
		.getByRole('radiogroup', { name: 'Weights in' })
		.getByRole('radio', { name: 'lb' })
		.click();
	await page
		.getByRole('radiogroup', { name: 'Distances in' })
		.getByRole('radio', { name: 'mi' })
		.click();
	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	expect(
		await query('select name, weight_unit, distance_unit, time_zone from athlete_profiles')
	).toEqual([
		{ name: 'Niko', weight_unit: 'lb', distance_unit: 'mi', time_zone: 'America/Los_Angeles' }
	]);

	await page.reload();
	await editorReady(page);
	await expect(nameField(page)).toHaveValue('Niko');
	await picked(page, 'Weights in', 'lb');
	await picked(page, 'Distances in', 'mi');
	await captureScreen(page, testInfo, 'profile-basics');

	// Nothing unsaved, so leaving asks nothing.
	await page.getByTestId('back-to-profile').click();
	await expect(page).toHaveURL('/profile');
	await expect(page.getByTestId('owner-name')).toHaveText('Niko');
	await picked(page, 'Units', 'lb');
	await picked(page, 'Distance', 'mi');
	// Stored on the device, not only on this page.
	await gotoHydrated(page, '/profile');
	await picked(page, 'Units', 'lb');
	await picked(page, 'Distance', 'mi');
	expect(errors).toEqual([]);
});

test('an empty name is refused with an alert and saves nothing; with a name it saves', async ({
	page
}) => {
	await page.goto('/profile/basics');
	await editorReady(page);
	const name = nameField(page);
	await name.fill('   ');
	await page.getByTestId('save-section').click();
	const alert = page.getByRole('alert').filter({ hasText: 'Tell your coach what to call you' });
	await expect(alert).toBeVisible();
	await expect(name).toHaveAttribute('aria-invalid', 'true');
	await expect(name).toBeFocused();
	await expect(page.getByTestId('save-error')).toContainText('Check the highlighted fields.');
	await expect(toastWith(page, 'Saved')).toHaveCount(0);
	expect(await query('select name from athlete_profiles')).toEqual([{ name: 'Niko Cruz' }]);

	await name.fill('Nikolai');
	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	await expect(alert).toHaveCount(0);
	await expect(page.getByTestId('save-error')).toHaveCount(0);
	expect(await query('select name from athlete_profiles')).toEqual([{ name: 'Nikolai' }]);
});
