/**
 * Profile → Exercises: the ones the owner enjoys and the ones they’d rather swap out. Serial
 * (one test at a time, after the functional suites): every test starts from a blank training
 * profile, which every browser and worker shares.
 */
import AxeBuilder from '@axe-core/playwright';
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

const LIKES = 'Exercises you enjoy';
const DISLIKES = 'Exercises you’d rather swap out';
const BOTH = 'Each exercise once — it can’t be liked and disliked';
/** How far above the Save bar its fade reaches (`--space-6`). */
const FADE = 24;

/** The owner's preferences, by name. */
const rows = () =>
	query('select exercise, sentiment, reason from exercise_preferences order by exercise');

/** The editor has loaded in place of the skeleton. */
async function editorReady(page: Page) {
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
}

const field = (page: Page, list: string) => page.getByRole('textbox', { name: list, exact: true });
const pills = (page: Page, list: string) =>
	page.getByRole('list', { name: list, exact: true }).getByRole('listitem');
const suggestion = (page: Page, list: string, exercise: string) =>
	page
		.getByRole('group', { name: `Suggestions for ${list}` })
		.getByRole('button', { name: `Add ${exercise}`, exact: true });

/** Type an exercise into a list, as Return adds it. */
async function type(page: Page, list: string, exercise: string) {
	await field(page, list).fill(exercise);
	await field(page, list).press('Enter');
}

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test('likes from a suggestion and typed in, and a dislike, save and are there after a reload', async ({
	page
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	await gotoHydrated(page, '/profile');
	await page
		.getByRole('region', { name: 'Training profile' })
		.getByRole('link', { name: /Exercises/ })
		.click();
	await expect(page).toHaveURL('/profile/exercises');
	await expect(page.getByRole('heading', { level: 1, name: 'Exercises' })).toBeVisible();
	await editorReady(page);
	await expect(pills(page, LIKES)).toHaveCount(0);
	await expect(pills(page, DISLIKES)).toHaveCount(0);
	// Words that read the same on Profile and in onboarding.
	await expect(page.getByTestId('dislikes')).toContainText('Pain or an injury goes under Injuries');
	await expect(page.getByText(/previous step/i)).toHaveCount(0);

	await expect(suggestion(page, LIKES, 'Back squat')).toBeVisible();
	await suggestion(page, LIKES, 'Front squat').click();
	await expect(suggestion(page, LIKES, 'Front squat')).toHaveCount(0);
	await type(page, LIKES, 'Turkish get-up');
	await expect(pills(page, LIKES)).toHaveText(['Front squat', 'Turkish get-up']);
	// In the other list, a suggestion is no longer offered here either.
	await type(page, DISLIKES, 'Back squat');
	await expect(pills(page, DISLIKES)).toHaveText(['Back squat']);
	await expect(suggestion(page, LIKES, 'Back squat')).toHaveCount(0);
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth
	}));
	expect(scrollWidth).toBeLessThanOrEqual(innerWidth);

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
	await expect(pills(page, LIKES)).toHaveCount(2);
	await expect(pills(page, LIKES).filter({ hasText: 'Front squat' })).toHaveCount(1);
	await expect(pills(page, LIKES).filter({ hasText: 'Turkish get-up' })).toHaveCount(1);
	await expect(pills(page, DISLIKES)).toHaveText(['Back squat']);

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
		items: [{ exercise: 'Deadlift', sentiment: 'like' }]
	});
	await page.goto('/profile/exercises');
	await editorReady(page);
	await expect(pills(page, LIKES)).toHaveText(['Deadlift']);
	await type(page, DISLIKES, 'deadlift');
	await expect(pills(page, DISLIKES)).toHaveText(['deadlift']);

	await page.getByTestId('save-section').click();
	await expect(page.getByRole('alert').filter({ hasText: 'Each exercise once' })).toHaveCount(1);
	await expect(page.getByTestId('dislikes').getByRole('alert')).toHaveText(BOTH);
	await expect(field(page, DISLIKES)).toBeFocused();
	await expect(page.getByTestId('save-error')).toContainText('Check the highlighted fields');
	// In view: the message clears the Save bar, now taller with its notice, and the fade above it.
	const message = (await page.getByTestId('dislikes').getByRole('alert').boundingBox())!;
	const bar = (await page.getByTestId('save-error').locator('..').boundingBox())!;
	expect(message.y).toBeGreaterThanOrEqual(0);
	expect(message.y + message.height).toBeLessThanOrEqual(bar.y - FADE);
	expect(await rows()).toEqual([{ exercise: 'Deadlift', sentiment: 'like', reason: null }]);

	// In one list only, it saves.
	await page.getByTestId('dislikes').getByRole('button', { name: 'Remove deadlift' }).click();
	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	await expect(page.getByRole('alert').filter({ hasText: 'Each exercise once' })).toHaveCount(0);
	expect(await rows()).toEqual([{ exercise: 'Deadlift', sentiment: 'like', reason: null }]);
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
	await page.goto('/profile/exercises');
	await editorReady(page);
	await expect(pills(page, LIKES)).toHaveText(['Front squat']);
	await expect(pills(page, DISLIKES)).toHaveText(['Burpees']);

	await suggestion(page, LIKES, 'Deadlift').click();
	await suggestion(page, DISLIKES, 'Box jumps').click();
	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	expect(await rows()).toEqual([
		{ exercise: 'Box jumps', sentiment: 'dislike', reason: null },
		{ exercise: 'Burpees', sentiment: 'dislike', reason: 'Wrists ache in the push-up' },
		{ exercise: 'Deadlift', sentiment: 'like', reason: null },
		{ exercise: 'Front squat', sentiment: 'like', reason: 'Asked for more of it' }
	]);
});

for (const theme of ['dark', 'light'] as const) {
	test(`both lists, filled and refusing an exercise in both, have no WCAG A/AA violations (${theme})`, async ({
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
				{ exercise: 'Pull-ups', sentiment: 'like' },
				{ exercise: 'Burpees', sentiment: 'dislike' }
			]
		});
		await page.goto('/profile/exercises');
		await editorReady(page);
		if (theme === 'light')
			await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await type(page, DISLIKES, 'Pull-ups');
		await page.getByTestId('save-section').click();
		await expect(page.getByTestId('dislikes').getByRole('alert')).toHaveText(BOTH);
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(400);
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		expect(violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))).toEqual(
			[]
		);
		// Where the error took the owner: the list it is on, focused.
		await expect(field(page, DISLIKES)).toBeFocused();
		await captureScreen(page, testInfo, `profile-exercises-errors-${theme}`);
	});
}
