/**
 * Profile → Exercises: the ones the owner enjoys and the ones they’d rather swap out, as two
 * plain lists, each added to through a search of the exercise library that keeps the owner's own
 * words too. Serial (one test at a time, after the functional suites): every test starts from a
 * blank training profile, which every browser and worker shares.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { expectNoSideScroll } from './desktop';
import {
	captureScreen,
	gotoHydrated,
	profileAction,
	query,
	resetTrainingProfile,
	toastWith,
	trackConsoleErrors
} from './support';

type List = 'likes' | 'dislikes';
const QUESTION: Record<List, string> = {
	likes: 'What do you like doing?',
	dislikes: 'What would you rather swap out?'
};
const BOTH = 'Each exercise once — it can’t be liked and disliked';
/** How far above the Save bar its fade reaches (`--space-6`). */
const FADE = 24;

/** The owner's preferences, by name. */
const rows = () =>
	query('select exercise, sentiment, reason from exercise_preferences order by exercise');

/** The editor has loaded under the title. */
async function editorReady(page: Page) {
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
}

/** The exercises in a list, one row each. */
const names = (page: Page, list: List) => page.getByTestId(list).getByRole('listitem');
const searchbox = (page: Page) => page.getByRole('searchbox', { name: 'Search exercises' });
const results = (page: Page) => page.getByTestId('exercise-results');

/** Open a list's search: its question is the title, the field takes the typing, the library is in. */
async function openSearch(page: Page, list: List) {
	await page.getByTestId(`add-${list}`).click();
	await expect(page.getByRole('heading', { level: 1, name: QUESTION[list] })).toBeVisible();
	await expect(page.getByTestId('sub-back')).toHaveText('Exercises');
	await expect(searchbox(page)).toBeFocused();
	await expect(results(page)).toHaveAttribute('aria-busy', 'false');
}

/** Add an exercise the library has, by its name; back on the section, at the list's Add. */
async function addFromLibrary(page: Page, list: List, search: string, name: string) {
	await openSearch(page, list);
	await searchbox(page).fill(search);
	await results(page).getByRole('button', { name, exact: true }).click();
	await expect(page.getByTestId(`add-${list}`)).toBeFocused();
}

/** Add an exercise in the owner's own words; back on the section, at the list's Add. */
async function addOwnWords(page: Page, list: List, words: string) {
	await openSearch(page, list);
	await searchbox(page).fill(words);
	const own = page.getByTestId('exercise-own');
	await expect(own).toHaveAccessibleName(`Add “${words}” as you wrote it`);
	await own.click();
	await expect(page.getByTestId(`add-${list}`)).toBeFocused();
}

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test('likes from the library and in your own words, and a dislike, save and are there after a reload', async ({
	page
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	await gotoHydrated(page, '/profile');
	await page.getByTestId('section-exercises').click();
	await expect(page).toHaveURL('/profile/exercises');
	await expect(
		page.getByRole('heading', { level: 1, name: 'Exercises you like and avoid' })
	).toBeVisible();
	await editorReady(page);
	await expect(page.getByRole('heading', { level: 2, name: 'You like' })).toBeVisible();
	await expect(
		page.getByRole('heading', { level: 2, name: 'You’d rather swap out' })
	).toBeVisible();
	await expect(names(page, 'likes')).toHaveCount(0);
	await expect(names(page, 'dislikes')).toHaveCount(0);
	// Words that read the same on Profile and in onboarding.
	await expect(page.getByTestId('dislikes')).toContainText('Pain or an injury goes under Injuries');
	await expect(page.getByText(/previous step/i)).toHaveCount(0);

	// The search asks its question in the 32 px statement style.
	await openSearch(page, 'likes');
	await expect(page.getByRole('heading', { level: 1, name: QUESTION.likes })).toHaveCSS(
		'font-size',
		'32px'
	);
	// What was typed goes with the screen: back and in again, the field is empty.
	await searchbox(page).fill('front');
	await page.getByTestId('sub-back').click();
	await expect(page.getByTestId('add-likes')).toBeFocused();
	await openSearch(page, 'likes');
	await expect(searchbox(page)).toHaveValue('');
	await page.getByTestId('sub-back').click();

	await addFromLibrary(page, 'likes', 'front sq', 'Front squat');
	await addOwnWords(page, 'likes', 'Turkish get-up');
	await expect(names(page, 'likes')).toHaveText(['Front squat', 'Turkish get-up']);
	// In the other list's search, one already liked is marked Added, and is not a pick.
	await openSearch(page, 'dislikes');
	await searchbox(page).fill('front squat');
	await expect(results(page).getByText('Added', { exact: true })).toHaveCount(1);
	await expect(results(page).getByRole('button', { name: 'Front squat', exact: true })).toHaveCount(
		0
	);
	await expect(page.getByTestId('exercise-own')).toHaveCount(0);
	await searchbox(page).fill('back squat');
	await results(page).getByRole('button', { name: 'Back squat', exact: true }).click();
	await expect(names(page, 'dislikes')).toHaveText(['Back squat']);
	await expectNoSideScroll(page);

	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	await page.evaluate(() => scrollTo(0, 0));
	await captureScreen(page, testInfo, 'profile-exercises');
	expect(await rows()).toEqual([
		{ exercise: 'Back squat', sentiment: 'dislike', reason: null },
		{ exercise: 'Front squat', sentiment: 'like', reason: null },
		{ exercise: 'Turkish get-up', sentiment: 'like', reason: null }
	]);

	await page.reload();
	await editorReady(page);
	await expect(names(page, 'likes')).toHaveCount(2);
	await expect(names(page, 'likes').filter({ hasText: 'Front squat' })).toHaveCount(1);
	await expect(names(page, 'likes').filter({ hasText: 'Turkish get-up' })).toHaveCount(1);
	await expect(names(page, 'dislikes')).toHaveText(['Back squat']);

	// Nothing unsaved: leaving asks nothing.
	await page.getByTestId('back-to-profile').click();
	await expect(page).toHaveURL('/profile');
	expect(errors).toEqual([]);
});

test('the same exercise in both lists is refused with one alert, and nothing saves', async ({
	page,
	request
}) => {
	await profileAction(request, '/profile/exercises?/save', {
		items: [{ exercise: 'Turkish get-up', sentiment: 'like' }]
	});
	await gotoHydrated(page, '/profile/exercises');
	await editorReady(page);
	await expect(names(page, 'likes')).toHaveText(['Turkish get-up']);
	await addOwnWords(page, 'dislikes', 'turkish get-up');
	await expect(names(page, 'dislikes')).toHaveText(['turkish get-up']);

	await page.getByTestId('save-section').click();
	await expect(page.getByRole('alert').filter({ hasText: 'Each exercise once' })).toHaveCount(1);
	await expect(page.getByTestId('dislikes').getByRole('alert')).toHaveText(BOTH);
	await expect(page.getByTestId('save-error')).toContainText('Check the highlighted fields');
	// In view: the message clears the Save bar, now taller with its notice, and the fade above it.
	const message = (await page.getByTestId('dislikes').getByRole('alert').boundingBox())!;
	const bar = (await page.getByTestId('save-error').locator('..').boundingBox())!;
	expect(message.y).toBeGreaterThanOrEqual(0);
	expect(message.y + message.height).toBeLessThanOrEqual(bar.y - FADE);
	expect(await rows()).toEqual([{ exercise: 'Turkish get-up', sentiment: 'like', reason: null }]);

	// In one list only, it saves. The list is empty again, so the focus goes to its Add.
	await page.getByTestId('dislikes').getByRole('button', { name: 'Remove turkish get-up' }).click();
	await expect(names(page, 'dislikes')).toHaveCount(0);
	await expect(page.getByTestId('add-dislikes')).toBeFocused();
	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	await expect(page.getByRole('alert').filter({ hasText: 'Each exercise once' })).toHaveCount(0);
	expect(await rows()).toEqual([{ exercise: 'Turkish get-up', sentiment: 'like', reason: null }]);
});

test('what the coach stored about an exercise survives a save from the editor', async ({
	page
}) => {
	// The coach's own note on each, from a workout: nothing on this screen shows or edits it.
	await query(
		`insert into exercise_preferences (owner_id, exercise, sentiment, reason)
		 select id, 'Burpees', 'dislike', 'Wrists ache in the push-up' from owners
		 union all select id, 'Front squat', 'like', 'Asked for more of it' from owners`
	);
	await gotoHydrated(page, '/profile/exercises');
	await editorReady(page);
	await expect(names(page, 'likes')).toHaveText(['Front squat']);
	await expect(names(page, 'dislikes')).toHaveText(['Burpees']);

	await addFromLibrary(page, 'likes', 'deadlift', 'Deadlift');
	await addFromLibrary(page, 'dislikes', 'box', 'Box jump');
	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	expect(await rows()).toEqual([
		{ exercise: 'Box jump', sentiment: 'dislike', reason: null },
		{ exercise: 'Burpees', sentiment: 'dislike', reason: 'Wrists ache in the push-up' },
		{ exercise: 'Deadlift', sentiment: 'like', reason: null },
		{ exercise: 'Front squat', sentiment: 'like', reason: 'Asked for more of it' }
	]);
});

for (const theme of ['dark', 'light'] as const) {
	test(`both lists, the search, and refusing an exercise in both have no WCAG A/AA violations (${theme})`, async ({
		page,
		request
	}, testInfo) => {
		await page.addInitScript(
			(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
			theme
		);
		await profileAction(request, '/profile/exercises?/save', {
			items: [
				{ exercise: 'Front squat', sentiment: 'like' },
				{ exercise: 'Turkish get-up', sentiment: 'like' },
				{ exercise: 'Burpees', sentiment: 'dislike' }
			]
		});
		await gotoHydrated(page, '/profile/exercises');
		await editorReady(page);
		if (theme === 'light')
			await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		const audit = async () => {
			await page.evaluate(() => document.fonts.ready);
			await page.waitForTimeout(400);
			const { violations } = await new AxeBuilder({ page })
				.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
				.analyze();
			return violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
		};
		// The search, with an exercise already added, ones to pick and the owner's own words.
		await openSearch(page, 'dislikes');
		await searchbox(page).fill('front');
		await expect(results(page).getByText('Added', { exact: true })).toHaveCount(1);
		await expect(page.getByTestId('exercise-result').first()).toBeVisible();
		await expect(page.getByTestId('exercise-own')).toBeVisible();
		expect(await audit()).toEqual([]);
		await page.getByTestId('sub-back').click();

		await addOwnWords(page, 'dislikes', 'Turkish get-up');
		await page.getByTestId('save-section').click();
		await expect(page.getByTestId('dislikes').getByRole('alert')).toHaveText(BOTH);
		expect(await audit()).toEqual([]);
		await captureScreen(page, testInfo, `profile-exercises-errors-${theme}`);
	});
}
