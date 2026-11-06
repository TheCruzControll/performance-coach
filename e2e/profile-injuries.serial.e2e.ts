/**
 * Profile → Injuries: injuries and limitations, each with its area, side, severity, movements to
 * avoid and notes, active or resolved. Serial (one test at a time, after the functional suites):
 * every test starts from a blank training profile, which every browser and worker shares.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
	captureScreen,
	gotoHydrated,
	profileAction,
	query,
	resetTrainingProfile,
	toastWith,
	trackConsoleErrors
} from './support';

/** The editor has loaded in place of the skeleton. */
async function editorReady(page: Page) {
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
}

const avoidField = (card: Locator) => card.getByRole('textbox', { name: 'Movements to avoid' });

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test('with nothing saved, Injuries says there is nothing to work around', async ({ page }) => {
	const errors = trackConsoleErrors(page);
	await gotoHydrated(page, '/profile');
	const row = page
		.getByRole('region', { name: 'Training profile' })
		.getByRole('link', { name: /Injuries/ });
	await expect(row).toHaveAttribute('href', '/profile/injuries');
	await row.click();
	await expect(page).toHaveURL('/profile/injuries');
	await expect(page.getByRole('heading', { level: 1, name: 'Injuries' })).toBeVisible();
	await editorReady(page);

	const empty = page.getByTestId('injuries-empty');
	await expect(empty.getByRole('heading', { name: 'Nothing to work around' })).toBeVisible();
	await expect(page.getByTestId('injury')).toHaveCount(0);
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth
	}));
	expect(scrollWidth).toBeLessThanOrEqual(innerWidth);

	// A card added and taken out again leaves nothing to save: leaving asks nothing.
	await page.getByRole('button', { name: 'Add an injury or limitation' }).click();
	await expect(page.getByTestId('injury')).toHaveCount(1);
	await expect(empty).toHaveCount(0);
	await page.getByRole('button', { name: 'Remove new injury or limitation' }).click();
	await expect(empty).toBeVisible();
	await page.getByTestId('back-to-profile').click();
	await expect(page).toHaveURL('/profile');
	expect(errors).toEqual([]);
});

test('an injury needs its area, holds 60 characters a movement, and saves', async ({
	page
}, testInfo) => {
	await gotoHydrated(page, '/profile/injuries');
	await editorReady(page);
	await page.getByRole('button', { name: 'Add an injury or limitation' }).click();
	const card = page.getByTestId('injury');
	await expect(card.getByRole('heading', { name: 'New injury or limitation' })).toBeVisible();
	// Focus goes to what the card needs first: where it is.
	const where = card.getByRole('group', { name: 'Where?' });
	await expect(where.getByRole('radio', { name: 'Neck' })).toBeFocused();
	// Side is optional: none is an explicit choice, picked until another is.
	const side = card.getByRole('group', { name: 'Side' });
	await expect(side.getByRole('radio', { name: 'Doesn’t apply' })).toBeChecked();

	// Without an area, Save says what is missing and posts nothing.
	await card.getByRole('radio', { name: 'Moderate' }).check();
	await page.getByTestId('save-section').click();
	await expect(where.getByRole('alert')).toHaveText('Where is it?');
	await expect(where.getByRole('radio', { name: 'Neck' })).toHaveAttribute('aria-invalid', 'true');
	expect(await query('select id from injuries')).toEqual([]);
	// The errors go with their card: a new one in its place starts without them.
	await card.getByRole('button', { name: 'Remove new injury or limitation' }).click();
	await page.getByRole('button', { name: 'Add an injury or limitation' }).click();
	await expect(card).toHaveCount(1);
	await expect(where.getByRole('alert')).toHaveCount(0);
	await card.getByRole('radio', { name: 'Moderate' }).check();

	await where.getByRole('radio', { name: 'Knee' }).check();
	await side.getByRole('radio', { name: 'Left' }).check();
	await expect(card.getByRole('heading', { name: 'Left knee' })).toBeVisible();
	const avoid = avoidField(card);
	for (const movement of ['Jumping lunges', 'Box jumps']) {
		await avoid.fill(movement);
		await avoid.press('Enter');
	}
	await expect(
		card.getByRole('list', { name: 'Movements to avoid' }).getByRole('listitem')
	).toHaveText(['Jumping lunges', 'Box jumps']);
	// A movement over 60 characters (the schema's limit) cannot be typed.
	await expect(avoid).toHaveAttribute('maxlength', '60');
	await avoid.fill('x'.repeat(58));
	await avoid.pressSequentially('abcd');
	await expect(avoid).toHaveValue(`${'x'.repeat(58)}ab`);
	await avoid.fill('');
	await card.getByRole('textbox', { name: /Notes/ }).fill('Sore after long runs');

	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	await expect(where.getByRole('alert')).toHaveCount(0);
	await page.evaluate(() => scrollTo(0, 0));
	await captureScreen(page, testInfo, 'profile-injuries');
	expect(
		await query('select body_area, side, severity, avoid, notes, active, since from injuries')
	).toEqual([
		{
			body_area: 'knee',
			side: 'left',
			severity: 'moderate',
			avoid: ['Jumping lunges', 'Box jumps'],
			notes: 'Sore after long runs',
			active: true,
			since: null
		}
	]);

	await page.reload();
	await editorReady(page);
	const saved = page.getByRole('region', { name: 'Left knee' });
	await expect(saved.getByRole('radio', { name: 'Knee' })).toBeChecked();
	await expect(saved.getByRole('radio', { name: 'Left' })).toBeChecked();
	await expect(saved.getByRole('radio', { name: 'Moderate' })).toBeChecked();
	await expect(saved.getByRole('switch', { name: 'Still affecting training' })).toBeChecked();
	await expect(saved.getByTestId('injury-resolved')).toHaveCount(0);
});

test('saving again on the same visit keeps the injury, and its history', async ({ page }) => {
	await gotoHydrated(page, '/profile/injuries');
	await editorReady(page);
	await page.getByRole('button', { name: 'Add an injury or limitation' }).click();
	const card = page.getByTestId('injury');
	await card.getByRole('radio', { name: 'Knee' }).check();
	await card.getByRole('radio', { name: 'Moderate' }).check();
	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	const stored = await query('select id, created_at from injuries');
	expect(stored).toHaveLength(1);

	// Resolved without a reload: the same injury is updated, not added again in its place.
	await card.getByRole('switch', { name: 'Still affecting training' }).uncheck();
	await page.getByTestId('save-section').click();
	await expect
		.poll(() => query('select id, created_at, resolved_at is not null as resolved from injuries'))
		.toEqual([{ ...stored[0], resolved: true }]);
});

test('removing a card leaves the next one’s state with it; resolved stays listed as Resolved', async ({
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
	const cards = page.getByTestId('injury');
	const knee = page.getByRole('region', { name: 'Left knee' });
	await expect(cards).toHaveCount(1);
	// Half-typed, never added: it belongs to the knee's card alone.
	await avoidField(knee).fill('Pistol sq');

	await page.getByRole('button', { name: 'Add another' }).click();
	const added = cards.nth(1);
	await added.getByRole('radio', { name: 'Shoulder' }).check();
	await added.getByRole('radio', { name: 'Right', exact: true }).check();
	await added.getByRole('radio', { name: 'Mild' }).check();
	const shoulder = page.getByRole('region', { name: 'Right shoulder' });
	await avoidField(shoulder).fill('Overhead press');
	await avoidField(shoulder).press('Enter');
	await avoidField(shoulder).fill('Dips');

	await knee.getByRole('button', { name: 'Remove Left knee' }).click();
	await expect(cards).toHaveCount(1);
	await expect(knee).toHaveCount(0);
	await expect(avoidField(shoulder)).toHaveValue('Dips');
	await expect(
		shoulder.getByRole('list', { name: 'Movements to avoid' }).getByRole('listitem')
	).toHaveText(['Overhead press']);
	await expect(shoulder.getByRole('radio', { name: 'Mild' })).toBeChecked();

	await expect(shoulder.getByTestId('injury-resolved')).toHaveCount(0);
	await shoulder.getByRole('switch', { name: 'Still affecting training' }).uncheck();
	await expect(shoulder.getByTestId('injury-resolved')).toHaveText('Resolved');
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
			avoid: ['Overhead press'],
			active: false,
			resolved: true
		}
	]);

	await page.reload();
	await editorReady(page);
	await expect(cards).toHaveCount(1);
	await expect(shoulder.getByTestId('injury-resolved')).toHaveText('Resolved');
	await expect(
		shoulder.getByRole('switch', { name: 'Still affecting training' })
	).not.toBeChecked();
	await expect(
		shoulder.getByRole('list', { name: 'Movements to avoid' }).getByRole('listitem')
	).toHaveText(['Overhead press']);
});
