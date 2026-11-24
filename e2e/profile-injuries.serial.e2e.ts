/**
 * Profile → Injuries: one row per injury or limitation, resolved ones under Better now, each
 * opening its own screen (where, side and how much it limits you as sheets, what to leave out,
 * notes, It's better now and Remove this injury), saved with the section's Save. Serial (one test
 * at a time, after the functional suites): every test starts from a blank training profile, which
 * every browser and worker shares.
 */
import { expect, test, type Page } from '@playwright/test';
import {
	captureScreen,
	gotoHydrated,
	pick,
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

/** An injury's own screen is open, under this title. */
const screenTitle = (page: Page, name: string) =>
	page.getByRole('heading', { level: 1, name, exact: true });

const avoidField = (page: Page) =>
	page.getByRole('textbox', { name: 'What to leave out, in your words' });

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test('with nothing saved, Injuries says there is nothing to work around', async ({ page }) => {
	const errors = trackConsoleErrors(page);
	await gotoHydrated(page, '/profile');
	const row = page.getByTestId('section-injuries');
	await expect(row).toHaveAttribute('href', '/profile/injuries');
	await row.click();
	await expect(page).toHaveURL('/profile/injuries');
	await expect(screenTitle(page, 'Injuries')).toBeVisible();
	await expect(page.getByText('What your coach plans around.')).toBeVisible();
	await editorReady(page);

	const empty = page.getByTestId('injuries-empty');
	await expect(empty).toHaveText('Nothing to work around.');
	await expect(page.getByTestId('injury')).toHaveCount(0);
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth
	}));
	expect(scrollWidth).toBeLessThanOrEqual(innerWidth);

	// An injury added and taken out again leaves nothing to save: leaving asks nothing.
	await page.getByTestId('add-injury').click();
	await expect(screenTitle(page, 'New injury')).toBeVisible();
	await expect(page.getByTestId('sub-back')).toHaveText('Injuries');
	await expect(page.getByTestId('back-to-profile')).toHaveCount(0);
	await page.getByTestId('injury-remove').click();
	await expect(screenTitle(page, 'Injuries')).toBeVisible();
	await expect(empty).toBeVisible();
	// Its row is gone, so the way back lands on Add an injury.
	await expect(page.getByTestId('add-injury')).toBeFocused();
	// What was typed on a removed injury goes with it: the next new one (under the same draft key)
	// starts empty.
	await page.getByTestId('add-injury').click();
	await avoidField(page).fill('Box jumps');
	await page.getByTestId('injury-remove').click();
	await page.getByTestId('add-injury').click();
	await expect(screenTitle(page, 'New injury')).toBeVisible();
	await expect(avoidField(page)).toHaveValue('');
	await page.getByTestId('injury-remove').click();
	await expect(page.getByTestId('add-injury')).toBeFocused();
	await page.getByTestId('back-to-profile').click();
	await expect(page).toHaveURL('/profile');
	expect(errors).toEqual([]);
});

test('an injury needs its area, keeps what to leave out as typed, and saves', async ({
	page
}, testInfo) => {
	await gotoHydrated(page, '/profile/injuries');
	await editorReady(page);
	await page.getByTestId('add-injury').click();
	// Its own screen, with the focus on its title: nothing is picked for the owner.
	await expect(screenTitle(page, 'New injury')).toBeFocused();
	const where = page.getByTestId('injury-where');
	await expect(where).toHaveAccessibleName(/^Where\s*Choose$/);
	// Side is optional: none is an explicit answer until another is picked.
	await expect(page.getByTestId('injury-side')).toHaveAccessibleName(/^Side\s*Doesn’t apply$/);

	// Without an area, Save says what is missing, under the row, and posts nothing.
	await pick(page, page, 'How much it limits you', /^Moderate/);
	await page.getByTestId('save-section').click();
	await expect(where).toHaveAttribute('aria-invalid', 'true');
	await expect(page.getByText('Where is it?')).toBeVisible();
	await expect(where).toBeFocused();
	expect(await query('select id from injuries')).toEqual([]);
	// On the list, its row says it needs an answer, in the warning colour, and has the focus.
	await page.getByTestId('sub-back').click();
	const row = page.getByTestId('injury');
	await expect(row).toHaveAccessibleName(/^New injury\s*Needs an answer$/);
	await expect(row).toHaveAttribute('aria-invalid', 'true');
	await expect(row.getByText('Needs an answer', { exact: true })).toHaveAttribute(
		'data-tone',
		'warning'
	);
	await expect(row).toBeFocused();
	await row.click();
	await expect(screenTitle(page, 'New injury')).toBeVisible();
	// The errors go with their injury: a new one in its place starts without them.
	await page.getByTestId('injury-remove').click();
	await page.getByTestId('add-injury').click();
	await expect(screenTitle(page, 'New injury')).toBeVisible();
	await expect(where).not.toHaveAttribute('aria-invalid');
	await expect(page.getByText('Where is it?')).toHaveCount(0);

	// The title follows the answers.
	await pick(page, page, 'Where', 'Knee');
	await expect(screenTitle(page, 'Knee')).toBeVisible();
	await pick(page, page, 'Side', 'Left');
	await expect(screenTitle(page, 'Left knee')).toBeVisible();
	await pick(page, page, 'How much it limits you', /^Moderate/);
	await expect(page.getByTestId('injury-severity')).toHaveAccessibleName(
		/^How much it limits you\s*Moderate$/
	);

	// One line of words: a comma and a space stay as they are typed; a repeat is left out.
	const avoid = avoidField(page);
	await expect(avoid).toHaveAttribute('placeholder', 'Box jumps, deep lunges');
	await avoid.pressSequentially('Box jumps, Deep lunges, box jumps');
	await expect(avoid).toHaveValue('Box jumps, Deep lunges, box jumps');
	await page.getByRole('textbox', { name: /Anything else about it/ }).fill('Sore after long runs');

	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	expect(
		await query('select body_area, side, severity, avoid, notes, active, since from injuries')
	).toEqual([
		{
			body_area: 'knee',
			side: 'left',
			severity: 'moderate',
			avoid: ['Box jumps', 'Deep lunges'],
			notes: 'Sore after long runs',
			active: true,
			since: null
		}
	]);
	// Saved, a new injury goes by its stored id: the screen gives way to the list.
	await expect(row).toHaveAccessibleName(/^Left knee\s*Moderate$/);
	await page.evaluate(() => scrollTo(0, 0));
	await captureScreen(page, testInfo, 'profile-injuries');

	await page.reload();
	await editorReady(page);
	await expect(row).toHaveAccessibleName(/^Left knee\s*Moderate$/);
	await row.click();
	await expect(screenTitle(page, 'Left knee')).toBeFocused();
	await expect(where).toHaveAccessibleName(/^Where\s*Knee$/);
	await expect(page.getByTestId('injury-side')).toHaveAccessibleName(/^Side\s*Left$/);
	await expect(page.getByTestId('injury-better')).toHaveText('It’s better now');
	await expect(avoid).toHaveValue('Box jumps, Deep lunges');
	await expect(page.getByRole('textbox', { name: /Anything else about it/ })).toHaveValue(
		'Sore after long runs'
	);
	// Back on the list, the focus is on the injury's row.
	await page.getByTestId('sub-back').click();
	await expect(row).toBeFocused();
});

test('saving again on the same visit keeps the injury, and its history', async ({ page }) => {
	await gotoHydrated(page, '/profile/injuries');
	await editorReady(page);
	await page.getByTestId('add-injury').click();
	await pick(page, page, 'Where', 'Knee');
	await pick(page, page, 'How much it limits you', /^Moderate/);
	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	const stored = await query('select id, created_at from injuries');
	expect(stored).toHaveLength(1);

	// Resolved without a reload: the same injury is updated, not added again in its place.
	const row = page.getByTestId('injury');
	await row.click();
	await page.getByTestId('injury-better').click();
	const better = page.getByRole('region', { name: 'Better now' });
	// Under Better now, dimmed, with no answer at its end.
	await expect(better.getByTestId('injury')).toHaveAccessibleName('Knee');
	await expect(better.getByTestId('injury')).toBeFocused();
	await expect(page.getByTestId('injuries-empty')).toHaveText('Nothing to work around.');
	await page.getByTestId('save-section').click();
	await expect
		.poll(() => query('select id, created_at, resolved_at is not null as resolved from injuries'))
		.toEqual([{ ...stored[0], resolved: true }]);
});

test('removing an injury leaves the next one’s answers with it; resolved ones stay under Better now', async ({
	page,
	request
}) => {
	await profileAction(request, '/profile/injuries?/save', {
		injuries: [
			{
				bodyArea: 'knee',
				side: 'left',
				severity: 'moderate',
				avoid: ['Jumping lunges', 'Box jumps'],
				notes: null,
				active: true
			}
		]
	});
	await gotoHydrated(page, '/profile/injuries');
	await editorReady(page);
	const rows = page.getByTestId('injury');
	await expect(rows).toHaveCount(1);
	const avoid = avoidField(page);

	// Half-typed on the knee's screen: it belongs to the knee alone.
	await rows.click();
	await expect(screenTitle(page, 'Left knee')).toBeVisible();
	await expect(avoid).toHaveValue('Jumping lunges, Box jumps');
	await avoid.fill('Jumping lunges, Box jumps, Pistol sq');
	await page.getByTestId('sub-back').click();

	await page.getByTestId('add-injury').click();
	await pick(page, page, 'Where', 'Shoulder');
	await pick(page, page, 'Side', 'Right');
	await pick(page, page, 'How much it limits you', /^Mild/);
	await expect(screenTitle(page, 'Right shoulder')).toBeVisible();
	await expect(avoid).toHaveValue('');
	await avoid.fill('Overhead press, Dips');
	await page.getByTestId('sub-back').click();
	await expect(rows).toHaveCount(2);
	await expect(rows.nth(1)).toHaveAccessibleName(/^Right shoulder\s*Mild$/);
	await expect(rows.nth(1)).toBeFocused();

	await rows.first().click();
	await page.getByTestId('injury-remove').click();
	await expect(rows).toHaveCount(1);
	await expect(rows).toHaveAccessibleName(/^Right shoulder\s*Mild$/);
	await rows.click();
	await expect(screenTitle(page, 'Right shoulder')).toBeVisible();
	await expect(avoid).toHaveValue('Overhead press, Dips');
	await expect(page.getByTestId('injury-severity')).toHaveAccessibleName(
		/^How much it limits you\s*Mild$/
	);

	await page.getByTestId('injury-better').click();
	const better = page.getByRole('region', { name: 'Better now' });
	await expect(better).toContainText('Right shoulder');
	await expect(page.getByTestId('injuries-empty')).toHaveText('Nothing to work around.');
	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	expect(
		await query(
			'select body_area, side, severity, avoid, active, resolved_at is not null as resolved from injuries'
		)
	).toEqual([
		{
			body_area: 'shoulder',
			side: 'right',
			severity: 'mild',
			avoid: ['Overhead press', 'Dips'],
			active: false,
			resolved: true
		}
	]);

	await page.reload();
	await editorReady(page);
	await expect(rows).toHaveCount(1);
	await expect(better.getByTestId('injury')).toHaveAccessibleName('Right shoulder');
	await better.getByTestId('injury').click();
	await expect(page.getByTestId('injury-better')).toHaveText('It’s bothering me again');
	await expect(avoid).toHaveValue('Overhead press, Dips');
});
