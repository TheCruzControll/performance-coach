/**
 * Profile → Exercises links the owner's words to the library: two names for one exercise are
 * refused with a notice in the editor, never a failed save. Serial: it changes the one owner's
 * training profile, which every browser and worker shares.
 */
import { expect, test, type Page } from '@playwright/test';
import { gotoHydrated, query, resetTrainingProfile, trackConsoleErrors } from './support';

const LIKES = 'Exercises you enjoy';
const TWICE = 'You’ve listed Romanian deadlift twice (as “RDL” and “Romanian deadlift”)';

const field = (page: Page) => page.getByRole('textbox', { name: LIKES, exact: true });
const pills = (page: Page) =>
	page.getByRole('list', { name: LIKES, exact: true }).getByRole('listitem');

async function editorReady(page: Page) {
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
}

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test('liking RDL and Romanian deadlift shows the duplicate notice, and nothing is saved', async ({
	page
}) => {
	// The refused save answers 400, which the browser logs against the action it posted to.
	const refused: string[] = [];
	const errors = trackConsoleErrors(page, (msg) => {
		const at = new URL(msg.location().url || 'about:blank');
		const ours =
			msg.text().startsWith('Failed to load resource') &&
			`${at.pathname}${at.search}` === '/profile/exercises?/save';
		if (ours) refused.push(msg.text());
		return ours;
	});
	await gotoHydrated(page, '/profile/exercises');
	await editorReady(page);
	for (const exercise of ['RDL', 'Romanian deadlift']) {
		await field(page).fill(exercise);
		await field(page).press('Enter');
	}
	await expect(pills(page)).toHaveText(['RDL', 'Romanian deadlift']);

	await page.getByTestId('save-section').click();
	await expect(page.getByRole('alert').filter({ hasText: TWICE })).toHaveCount(1);
	await expect(page.getByTestId('save-error')).toContainText('Check the highlighted fields');
	expect(await query('select exercise from exercise_preferences')).toEqual([]);
	expect(refused).toHaveLength(1);

	await page.reload();
	await editorReady(page);
	await expect(pills(page)).toHaveCount(0);
	await expect(page.getByRole('alert').filter({ hasText: TWICE })).toHaveCount(0);
	expect(errors).toEqual([]);
});
