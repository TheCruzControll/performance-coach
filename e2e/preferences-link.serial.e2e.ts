/**
 * Profile → Exercises links the owner's words to the library: two names for one exercise are
 * refused with a notice in the editor, never a failed save. Serial: it changes the one owner's
 * training profile, which every browser and worker shares.
 */
import { expect, test, type Page } from '@playwright/test';
import { gotoHydrated, query, resetTrainingProfile, trackConsoleErrors } from './support';

const TWICE = 'You’ve listed Romanian deadlift twice (as “RDL” and “Romanian deadlift”)';

/** The exercises liked, one row each. */
const likes = (page: Page) => page.getByTestId('likes').getByRole('listitem');
const searchbox = (page: Page) => page.getByRole('searchbox', { name: 'Search exercises' });

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
	// "RDL" in the owner's own words, then Romanian deadlift from the library's search.
	for (const [search, pick] of [
		['RDL', page.getByTestId('exercise-own')],
		['Romanian deadlift', page.getByRole('button', { name: 'Romanian deadlift', exact: true })]
	] as const) {
		await page.getByTestId('add-likes').click();
		await expect(page.getByTestId('exercise-results')).toHaveAttribute('aria-busy', 'false');
		await searchbox(page).fill(search);
		await pick.click();
		await expect(page.getByTestId('add-likes')).toBeVisible();
	}
	await expect(likes(page)).toHaveText(['RDL', 'Romanian deadlift']);

	await page.getByTestId('save-section').click();
	await expect(page.getByRole('alert').filter({ hasText: TWICE })).toHaveCount(1);
	await expect(page.getByTestId('save-error')).toContainText('Check the highlighted fields');
	expect(await query('select exercise from exercise_preferences')).toEqual([]);
	expect(refused).toHaveLength(1);

	await page.reload();
	await editorReady(page);
	await expect(likes(page)).toHaveCount(0);
	await expect(page.getByRole('alert').filter({ hasText: TWICE })).toHaveCount(0);
	expect(errors).toEqual([]);
});
