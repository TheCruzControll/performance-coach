/**
 * Profile → Goals: event and general goals ranked by priority, added (one path per kind, or
 * several at once) and edited in a code-split sheet, each saved the moment it changes (the
 * screen has no Save bar); paused, achieved, dropped or deleted from the same sheet; moved up
 * or down the ranking with their arrows. Serial (one test at a time, after the functional
 * suites): every test starts from a blank training profile, which every browser and worker
 * shares.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
	captureScreen,
	gotoHydrated,
	profileAction,
	query,
	resetTrainingProfile,
	SAME_ORIGIN,
	toastWith,
	trackConsoleErrors
} from './support';

const CLIENT = path.resolve(import.meta.dirname, '../.svelte-kit/output/client');

/** A module's chunk in the build under test (its file and styles), from Vite's manifest. */
function built(source: string): { file: string; css?: string[] } {
	const manifest = JSON.parse(readFileSync(`${CLIENT}/.vite/manifest.json`, 'utf8')) as Record<
		string,
		{ file: string; css?: string[] } | undefined
	>;
	const chunk = manifest[source];
	if (!chunk) throw new Error(`${source} is not in the build under test`);
	return chunk;
}

const chunkFile = (source: string) => built(source).file;

const EDITOR = 'src/lib/ui/profile/GoalsEditor.svelte';
const SHEET = 'src/lib/ui/profile/GoalSheet.svelte';

/** A fight in March and a marathon in December, as the sheet saves them. */
const FIGHT = {
	kind: 'event',
	title: 'First Muay Thai fight',
	disciplines: ['muay_thai'],
	eventType: 'Muay Thai fight',
	eventDate: '2027-03-14',
	weightClass: '−71 kg'
};
const MARATHON = {
	kind: 'event',
	title: 'Valencia marathon',
	disciplines: ['distance_running'],
	eventType: 'Marathon',
	eventDate: '2027-12-05',
	targetPerformance: 'Sub 3:30'
};
const STRENGTH = {
	kind: 'general',
	title: 'Keep my strength',
	disciplines: ['strength'],
	focus: 'Hold squat and deadlift',
	measure: 'Top sets at RPE 8 stay within 5%'
};

/** The editor has loaded in place of the skeleton. */
async function editorReady(page: Page) {
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
}

const sheetOf = (page: Page) => page.getByTestId('goal-sheet');
const statusOf = (page: Page) => sheetOf(page).getByRole('group', { name: 'Status' });
const textbox = (page: Page, name: string | RegExp) =>
	sheetOf(page).getByRole('textbox', { name, exact: typeof name === 'string' });
const arrow = (page: Page, title: string, way: 'up' | 'down') =>
	page.getByRole('button', { name: `Move ${title} ${way}`, exact: true });

/** The fight, the marathon and the strength goal, ranked 1, 2 and 3. */
async function threeGoals(request: APIRequestContext) {
	for (const goal of [FIGHT, MARATHON, STRENGTH]) {
		await profileAction(request, '/profile/goals?/saveGoal', goal);
	}
}

/** The open goals' titles as Postgres ranks them. */
const storedRanking = async () =>
	(
		await query<{ title: string }>(
			'select title from training_goals where priority is not null order by priority'
		)
	).map((g) => g.title);

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test('event goals are added and edited from Profile, ranked, and still there after a reload and in Postgres', async ({
	page
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	await gotoHydrated(page, '/profile');
	await page
		.getByRole('region', { name: 'Training profile' })
		.getByRole('link', { name: /Goals/ })
		.click();
	await expect(page).toHaveURL('/profile/goals');
	await expect(page.getByRole('heading', { level: 1, name: 'Goals' })).toBeVisible();
	await editorReady(page);
	await expect(page.getByTestId('goals-empty')).toContainText('What are you training for?');
	// Every change saves itself: there is no Save bar.
	await expect(page.getByTestId('save-section')).toHaveCount(0);

	const sheet = sheetOf(page);
	await page.getByTestId('goal-path-event').click();
	await expect(sheet.getByRole('heading', { name: 'New goal' })).toBeVisible();
	await textbox(page, 'Goal').fill('First Muay Thai fight');
	await sheet.getByRole('checkbox', { name: 'Muay Thai' }).check();
	await sheet
		.getByRole('group', { name: 'Suggested events' })
		.getByRole('button', { name: 'Muay Thai fight' })
		.click();
	await expect(textbox(page, 'Event')).toHaveValue('Muay Thai fight');
	await sheet.getByLabel('Event date').fill('2027-03-14');
	await textbox(page, /^Weight class/).fill('−71 kg');
	await sheet.getByRole('button', { name: 'Save goal' }).click();
	await expect(toastWith(page, 'Goal saved')).toBeVisible();
	await expect(sheet).toBeHidden();

	const rows = page.getByTestId('goal-row');
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText('First Muay Thai fight');
	await expect(rows.first()).toContainText('Top priority');
	await expect(rows.first()).toContainText('Muay Thai fight · 14 Mar 2027 · −71 kg');

	// A second goal is ranked below the first.
	await page.getByTestId('add-goal').click();
	await expect(sheet.getByRole('heading', { name: 'New goal' })).toBeVisible();
	await expect(textbox(page, 'Goal')).toHaveValue('');
	await textbox(page, 'Goal').fill('Valencia marathon');
	await sheet.getByRole('checkbox', { name: 'Half / marathon' }).check();
	await sheet.getByRole('button', { name: 'Marathon', exact: true }).click();
	await sheet.getByLabel('Event date').fill('2027-12-05');
	await textbox(page, /^Target/).fill('Sub 3:30');
	await sheet.getByRole('button', { name: 'Save goal' }).click();
	await expect(sheet).toBeHidden();
	await expect(rows).toHaveCount(2);
	await expect(rows.nth(1)).toContainText('Valencia marathon');
	await expect(rows.nth(1)).toContainText('Marathon · 5 Dec 2027');
	await expect(rows.nth(1)).not.toContainText('Top priority');
	await expect(rows.nth(0)).toHaveAccessibleName(/^Priority 1: First Muay Thai fight/);
	await expect(rows.nth(1)).toHaveAccessibleName(/^Priority 2: Valencia marathon/);

	// Editing #1 keeps its rank.
	await rows.first().click();
	await expect(sheet.getByRole('heading', { name: 'Edit goal' })).toBeVisible();
	await expect(textbox(page, 'Goal')).toHaveValue('First Muay Thai fight');
	await expect(sheet.getByRole('checkbox', { name: 'Muay Thai' })).toBeChecked();
	await expect(sheet.getByLabel('Event date')).toHaveValue('2027-03-14');
	await textbox(page, 'Goal').fill('A-class Muay Thai fight');
	await textbox(page, /^Target/).fill('Win by decision');
	await page.evaluate(() => document.fonts.ready);
	await captureScreen(page, testInfo, 'goal-sheet');
	await sheet.getByRole('button', { name: 'Save goal' }).click();
	await expect(sheet).toBeHidden();
	await expect(rows.first()).toContainText('A-class Muay Thai fight');
	await expect(rows.first()).toContainText('Top priority');
	// Every change saved itself, so leaving asks nothing.
	await page.getByTestId('back-to-profile').click();
	await expect(page).toHaveURL('/profile');
	await expect(page.getByTestId('discard-sheet')).toHaveCount(0);

	expect(
		await query(
			`select title, priority, event_type, event_date::text, weight_class, target_performance
			   from training_goals order by priority`
		)
	).toEqual([
		{
			title: 'A-class Muay Thai fight',
			priority: 1,
			event_type: 'Muay Thai fight',
			event_date: '2027-03-14',
			weight_class: '−71 kg',
			target_performance: 'Win by decision'
		},
		{
			title: 'Valencia marathon',
			priority: 2,
			event_type: 'Marathon',
			event_date: '2027-12-05',
			weight_class: null,
			target_performance: 'Sub 3:30'
		}
	]);
	expect(
		await query(
			`select change, source, count(*)::int as times from training_goal_events
			  group by change, source order by change`
		)
	).toEqual([
		{ change: 'created', source: 'profile', times: 2 },
		{ change: 'updated', source: 'profile', times: 1 }
	]);

	await page.goBack();
	await expect(page).toHaveURL('/profile/goals');
	await page.reload();
	await editorReady(page);
	await expect(rows).toHaveCount(2);
	await expect(rows.first()).toContainText('A-class Muay Thai fight');
	await expect(rows.first()).toContainText('Top priority');
	await expect(rows.nth(1)).toContainText('Valencia marathon');
	await page.evaluate(() => scrollTo(0, 0));
	await captureScreen(page, testInfo, 'profile-goals');
	await rows.first().click();
	await expect(textbox(page, /^Target/)).toHaveValue('Win by decision');
	await sheet.getByRole('button', { name: 'Close' }).click();
	await expect(sheet).toBeHidden();
	expect(errors).toEqual([]);
});

test('a general goal saves only once it says what to improve and how it’s measured, and the sheet says what is missing', async ({
	page
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	await gotoHydrated(page, '/profile/goals');
	await editorReady(page);
	// PRD §2's three ways in, each clear of the tab bar at rest.
	const empty = page.getByTestId('goals-editor');
	const nav = await page.getByRole('navigation', { name: 'Primary' }).boundingBox();
	for (const name of [/^A specific event/, /^A general goal/, /^Several goals at once/]) {
		const way = empty.getByRole('button', { name });
		await expect(way).toBeVisible();
		const box = await way.boundingBox();
		expect(box!.y + box!.height, `${name}`).toBeLessThanOrEqual(nav!.y);
	}
	await captureScreen(page, testInfo, 'profile-goals-empty');

	await page.getByTestId('goal-path-general').click();
	const sheet = sheetOf(page);
	await expect(sheet.getByRole('heading', { name: 'New goal' })).toBeVisible();
	await expect(sheet.getByRole('radio', { name: 'General' })).toBeChecked();
	await expect(textbox(page, 'Event')).toHaveCount(0);
	await textbox(page, 'Goal').fill('A stronger deadlift');
	await sheet.getByRole('checkbox', { name: 'Strength' }).check();
	const save = sheet.getByRole('button', { name: 'Save goal' });
	const focus = textbox(page, 'What to improve');
	const measure = textbox(page, 'How it’s measured');
	await save.click();
	await expect(
		sheet.getByRole('alert').filter({ hasText: 'What do you want to improve?' })
	).toBeVisible();
	await expect(
		sheet.getByRole('alert').filter({ hasText: 'How will you know it’s working?' })
	).toBeVisible();
	await expect(focus).toHaveAttribute('aria-invalid', 'true');
	await expect(measure).toHaveAttribute('aria-invalid', 'true');
	await expect(focus).toBeFocused();
	expect(await query('select id from training_goals')).toEqual([]);

	// What to improve alone is not enough.
	await focus.fill('Deadlift strength');
	await save.click();
	await expect(
		sheet.getByRole('alert').filter({ hasText: 'How will you know it’s working?' })
	).toBeVisible();
	await expect(focus).not.toHaveAttribute('aria-invalid', 'true');
	await expect(measure).toBeFocused();
	expect(await query('select id from training_goals')).toEqual([]);

	await measure.fill('e1RM trend');
	await sheet.getByLabel(/^Target date/).fill('2027-06-30');
	await save.click();
	await expect(toastWith(page, 'Goal saved')).toBeVisible();
	await expect(sheet).toBeHidden();
	const row = page.getByTestId('goal-row');
	await expect(row).toHaveCount(1);
	await expect(row).toContainText('Top priority');
	await expect(row).toContainText('Deadlift strength · e1RM trend · by 30 Jun 2027');
	expect(
		await query(
			`select kind, title, priority, focus, measure, target_date::text, event_type, event_date
			   from training_goals`
		)
	).toEqual([
		{
			kind: 'general',
			title: 'A stronger deadlift',
			priority: 1,
			focus: 'Deadlift strength',
			measure: 'e1RM trend',
			target_date: '2027-06-30',
			event_type: null,
			event_date: null
		}
	]);

	await page.reload();
	await editorReady(page);
	await row.click();
	await expect(sheet.getByRole('heading', { name: 'Edit goal' })).toBeVisible();
	await expect(sheet.getByRole('radio', { name: 'General' })).toBeChecked();
	await expect(focus).toHaveValue('Deadlift strength');
	await expect(measure).toHaveValue('e1RM trend');
	await expect(sheet.getByLabel(/^Target date/)).toHaveValue('2027-06-30');
	await captureScreen(page, testInfo, 'goal-sheet-general');
	expect(errors).toEqual([]);
});

test('switching an event goal to general clears its event fields in Postgres', async ({
	page,
	request
}) => {
	await profileAction(request, '/profile/goals?/saveGoal', {
		...FIGHT,
		targetPerformance: 'Win by decision',
		requirements: 'Make weight the day before'
	});
	await gotoHydrated(page, '/profile/goals');
	await editorReady(page);
	await page.getByTestId('goal-row').click();
	const sheet = sheetOf(page);
	await expect(sheet.getByRole('heading', { name: 'Edit goal' })).toBeVisible();
	await expect(sheet.getByRole('radio', { name: 'Event' })).toBeChecked();
	await sheet.getByRole('radio', { name: 'General' }).click();
	await expect(textbox(page, 'Event')).toHaveCount(0);
	await expect(sheet.getByLabel('Event date')).toHaveCount(0);
	// What both kinds share stays.
	await expect(textbox(page, 'Goal')).toHaveValue('First Muay Thai fight');
	await expect(sheet.getByRole('checkbox', { name: 'Muay Thai' })).toBeChecked();

	// Errors belong to the kind they were about: switching back and forth clears them, and keeps
	// what was typed for the event.
	const save = sheet.getByRole('button', { name: 'Save goal' });
	await save.click();
	await expect(sheet.getByTestId('goal-sheet-error')).toContainText('Check the highlighted fields');
	await sheet.getByRole('radio', { name: 'Event' }).click();
	await expect(textbox(page, 'Event')).toHaveValue('Muay Thai fight');
	await expect(sheet.getByRole('alert')).toHaveCount(0);
	await expect(sheet.getByTestId('goal-sheet-error')).toHaveCount(0);
	await sheet.getByRole('radio', { name: 'General' }).click();

	await textbox(page, 'What to improve').fill('Clinch strength');
	await textbox(page, 'How it’s measured').fill('Sparring rounds without fading');
	await save.click();
	await expect(sheet).toBeHidden();
	const row = page.getByTestId('goal-row');
	await expect(row).toContainText('Clinch strength · Sparring rounds without fading');
	await expect(row).not.toContainText('−71 kg');
	expect(
		await query(
			`select kind, title, priority, disciplines, focus, measure, target_date, event_type,
			        event_date, weight_class, target_performance, requirements
			   from training_goals`
		)
	).toEqual([
		{
			kind: 'general',
			title: 'First Muay Thai fight',
			priority: 1,
			disciplines: ['muay_thai'],
			focus: 'Clinch strength',
			measure: 'Sparring rounds without fading',
			target_date: null,
			event_type: null,
			event_date: null,
			weight_class: null,
			target_performance: null,
			requirements: null
		}
	]);
});

test('several goals at once are added one by one and ranked 1 and 2 in the order they were added', async ({
	page
}, testInfo) => {
	await gotoHydrated(page, '/profile/goals');
	await editorReady(page);
	await page.getByTestId('goal-path-several').click();
	const sheet = sheetOf(page);
	await expect(sheet.getByRole('heading', { name: 'New goal' })).toBeVisible();
	// The same sheet, its kind picked at the top: an event unless switched.
	await expect(sheet.getByRole('radio', { name: 'Event' })).toBeChecked();
	await textbox(page, 'Goal').fill('First Muay Thai fight');
	await sheet.getByRole('checkbox', { name: 'Muay Thai' }).check();
	await textbox(page, 'Event').fill('Muay Thai fight');
	await sheet.getByLabel('Event date').fill('2027-03-14');
	await sheet.getByRole('button', { name: 'Save goal' }).click();
	await expect(sheet).toBeHidden();

	const rows = page.getByTestId('goal-row');
	await expect(rows).toHaveCount(1);
	const next = page.getByTestId('add-goal');
	const note = 'Goals rank in the order you add them, so add the next most important one.';
	await expect(next).toHaveText('Add another goal');
	await expect(page.getByTestId('goals-several-note')).toHaveText(note);
	await expect(next).toHaveAccessibleDescription(note);

	await next.click();
	await expect(sheet.getByRole('heading', { name: 'New goal' })).toBeVisible();
	await sheet.getByRole('radio', { name: 'General' }).click();
	await textbox(page, 'Goal').fill('Keep my strength');
	await sheet.getByRole('checkbox', { name: 'Strength' }).check();
	await textbox(page, 'What to improve').fill('Hold squat and deadlift');
	await textbox(page, 'How it’s measured').fill('Top sets at RPE 8 stay within 5%');
	await sheet.getByRole('button', { name: 'Save goal' }).click();
	await expect(sheet).toBeHidden();

	await expect(rows).toHaveCount(2);
	await expect(rows.nth(0)).toHaveAccessibleName(/^Priority 1: First Muay Thai fight/);
	await expect(rows.nth(0)).toContainText('Top priority');
	await expect(rows.nth(1)).toHaveAccessibleName(/^Priority 2: Keep my strength/);
	await expect(rows.nth(1)).not.toContainText('Top priority');
	await expect(page.getByTestId('goals-several-note')).toBeVisible();
	await captureScreen(page, testInfo, 'profile-goals-several');
	expect(
		await query(`select title, kind, priority from training_goals order by created_at`)
	).toEqual([
		{ title: 'First Muay Thai fight', kind: 'event', priority: 1 },
		{ title: 'Keep my strength', kind: 'general', priority: 2 }
	]);
});

test('an event without a date says so as an alert, moves focus to the date and saves nothing', async ({
	page
}) => {
	await gotoHydrated(page, '/profile/goals');
	await editorReady(page);
	await page.getByTestId('goal-path-event').click();
	const sheet = sheetOf(page);
	await textbox(page, 'Goal').fill('First Muay Thai fight');
	await sheet.getByRole('checkbox', { name: 'Muay Thai' }).check();
	await textbox(page, 'Event').fill('Muay Thai fight');
	await sheet.getByRole('button', { name: 'Save goal' }).click();

	const date = sheet.getByLabel('Event date');
	await expect(sheet.getByRole('alert').filter({ hasText: 'Pick the event date' })).toBeVisible();
	await expect(date).toHaveAttribute('aria-invalid', 'true');
	await expect(date).toBeFocused();
	await expect(sheet).toBeVisible();
	expect(await query('select id from training_goals')).toEqual([]);

	// Fixed, it saves.
	await date.fill('2027-03-14');
	await sheet.getByRole('button', { name: 'Save goal' }).click();
	await expect(sheet).toBeHidden();
	await expect(page.getByTestId('goal-row')).toHaveCount(1);
});

test('offline, the sheet says it can’t reach the server and keeps the goal; online, it saves', async ({
	page,
	context
}) => {
	await gotoHydrated(page, '/profile/goals');
	await editorReady(page);
	await page.getByTestId('goal-path-event').click();
	const sheet = sheetOf(page);
	await textbox(page, 'Goal').fill('First Muay Thai fight');
	await sheet.getByRole('checkbox', { name: 'Muay Thai' }).check();
	await textbox(page, 'Event').fill('Muay Thai fight');
	await sheet.getByLabel('Event date').fill('2027-03-14');

	await context.setOffline(true);
	const save = sheet.getByRole('button', { name: 'Save goal' });
	// From the keyboard: the button is disabled while it saves, and gets its focus back after.
	await save.focus();
	await page.keyboard.press('Enter');
	await expect(sheet.getByTestId('goal-sheet-error')).toContainText('Can’t reach the server');
	await expect(save).toBeFocused();
	await expect(textbox(page, 'Goal')).toHaveValue('First Muay Thai fight');
	expect(await query('select id from training_goals')).toEqual([]);

	await context.setOffline(false);
	await save.click();
	await expect(sheet).toBeHidden();
	await expect(page.getByTestId('goal-row')).toHaveCount(1);
});

test('a discipline of your own is named, and the goal shows it by that name', async ({ page }) => {
	await gotoHydrated(page, '/profile/goals');
	await editorReady(page);
	await page.getByTestId('goal-path-event').click();
	const sheet = sheetOf(page);
	await textbox(page, 'Goal').fill('First bouldering comp');
	await sheet.getByRole('checkbox', { name: 'Custom' }).check();
	await textbox(page, 'Event').fill('Bouldering comp');
	await sheet.getByLabel('Event date').fill('2027-05-01');
	await sheet.getByRole('button', { name: 'Save goal' }).click();
	const name = textbox(page, 'Name your discipline');
	await expect(
		sheet.getByRole('alert').filter({ hasText: 'Name your custom discipline' })
	).toBeVisible();
	await expect(name).toBeFocused();

	await name.fill('Bouldering');
	await sheet.getByRole('button', { name: 'Save goal' }).click();
	await expect(sheet).toBeHidden();
	const row = page.getByTestId('goal-row').first();
	await expect(row.getByText('Bouldering', { exact: true })).toBeVisible();
	await expect(row.getByText('Custom', { exact: true })).toHaveCount(0);
	expect(await query('select disciplines, custom_discipline from training_goals')).toEqual([
		{ disciplines: ['custom'], custom_discipline: 'Bouldering' }
	]);
});

test('the weight class and the target show what is wrong with them', async ({ page, request }) => {
	await profileAction(request, '/profile/goals?/saveGoal', FIGHT);
	await gotoHydrated(page, '/profile/goals');
	await editorReady(page);
	await page.getByTestId('goal-row').first().click();
	const sheet = sheetOf(page);
	const weightClass = textbox(page, /^Weight class/);
	const target = textbox(page, /^Target/);
	// Each field holds at most what the schema takes; past that (as another client could send),
	// the schema refuses it and the field says why.
	for (const field of [weightClass, target]) {
		await field.evaluate((input) => input.removeAttribute('maxlength'));
	}
	await weightClass.fill('x'.repeat(41));
	await target.fill('y'.repeat(201));
	await sheet.getByRole('button', { name: 'Save goal' }).click();
	await expect(
		sheet.getByRole('alert').filter({ hasText: 'Keep it under 40 characters' })
	).toBeVisible();
	await expect(
		sheet.getByRole('alert').filter({ hasText: 'Keep it under 200 characters' })
	).toBeVisible();
	await expect(weightClass).toHaveAttribute('aria-invalid', 'true');
	await expect(target).toHaveAttribute('aria-invalid', 'true');
	await expect(weightClass).toBeFocused();
	expect(await query('select weight_class from training_goals')).toEqual([
		{ weight_class: '−71 kg' }
	]);
});

test('closing the sheet gives focus back to what opened it', async ({ page, request }) => {
	await gotoHydrated(page, '/profile/goals');
	await editorReady(page);
	const sheet = sheetOf(page);
	const path = page.getByTestId('goal-path-event');
	await path.focus();
	await page.keyboard.press('Enter');
	await expect(sheet.getByRole('heading', { name: 'New goal' })).toBeVisible();
	await sheet.getByRole('button', { name: 'Close' }).click();
	await expect(sheet).toBeHidden();
	await expect(path).toBeFocused();

	await profileAction(request, '/profile/goals?/saveGoal', FIGHT);
	await page.reload();
	await editorReady(page);
	const row = page.getByTestId('goal-row').first();
	await row.focus();
	await page.keyboard.press('Enter');
	await expect(sheet.getByRole('heading', { name: 'Edit goal' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(sheet).toBeHidden();
	await expect(row).toBeFocused();
	expect(await query('select title from training_goals')).toEqual([
		{ title: 'First Muay Thai fight' }
	]);
});

test('a goal achieved leaves the ranking for Past goals and the rest move up; made active again, it goes last', async ({
	page,
	request
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	for (const goal of [FIGHT, MARATHON, STRENGTH]) {
		await profileAction(request, '/profile/goals?/saveGoal', goal);
	}
	await gotoHydrated(page, '/profile/goals');
	await editorReady(page);
	const rows = page.getByTestId('goal-row');
	const past = page.getByRole('region', { name: 'Past goals' });
	const pastRows = past.getByTestId('past-goal-row');
	await expect(rows).toHaveCount(3);
	await expect(past).toHaveCount(0);

	const sheet = sheetOf(page);
	const status = statusOf(page);
	const save = sheet.getByRole('button', { name: 'Save goal' });
	await rows.first().click();
	await expect(sheet.getByRole('heading', { name: 'Edit goal' })).toBeVisible();
	await expect(status.getByRole('radio', { name: 'Active' })).toBeChecked();
	await status.getByRole('radio', { name: 'Achieved' }).check();
	await save.click();
	await expect(toastWith(page, 'Goal saved')).toBeVisible();
	await expect(sheet).toBeHidden();
	await expect(rows).toHaveCount(2);
	await expect(rows.nth(0)).toHaveAccessibleName(/^Priority 1: Valencia marathon/);
	await expect(rows.nth(0)).toContainText('Top priority');
	await expect(rows.nth(1)).toHaveAccessibleName(/^Priority 2: Keep my strength/);
	await expect(pastRows).toHaveCount(1);
	await expect(pastRows.first()).toContainText('First Muay Thai fight');
	await expect(pastRows.first()).toContainText('Achieved');
	await expect(pastRows.first()).toContainText('Muay Thai fight · 14 Mar 2027 · −71 kg');

	// Paused keeps its rank, and says so.
	await rows.nth(1).click();
	await status.getByRole('radio', { name: 'Paused' }).check();
	await save.click();
	await expect(sheet).toBeHidden();
	await expect(rows.nth(1)).toHaveAccessibleName(/^Priority 2: Keep my strength/);
	await expect(rows.nth(1)).toContainText('Paused');
	await expect(rows.nth(0)).not.toContainText('Paused');
	expect(
		await query(
			`select title, status, priority, closed_at is not null as closed
			   from training_goals order by priority nulls last`
		)
	).toEqual([
		{ title: 'Valencia marathon', status: 'active', priority: 1, closed: false },
		{ title: 'Keep my strength', status: 'paused', priority: 2, closed: false },
		{ title: 'First Muay Thai fight', status: 'achieved', priority: null, closed: true }
	]);

	await page.reload();
	await editorReady(page);
	await expect(rows).toHaveCount(2);
	await expect(rows.nth(0)).toContainText('Top priority');
	await expect(rows.nth(1)).toContainText('Paused');
	await expect(pastRows).toHaveCount(1);
	await expect(pastRows.first()).toContainText('Achieved');
	await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
	await captureScreen(page, testInfo, 'profile-goals-past');

	// Active again: back in the ranking, below the goals that stayed in it.
	await pastRows.first().click();
	await expect(sheet.getByRole('heading', { name: 'Edit goal' })).toBeVisible();
	await expect(status.getByRole('radio', { name: 'Achieved' })).toBeChecked();
	await status.getByRole('radio', { name: 'Active' }).check();
	await captureScreen(page, testInfo, 'goal-sheet-status');
	await save.click();
	await expect(sheet).toBeHidden();
	await expect(rows).toHaveCount(3);
	await expect(rows.nth(2)).toHaveAccessibleName(/^Priority 3: First Muay Thai fight/);
	await expect(past).toHaveCount(0);
	expect(
		await query(
			`select title, status, priority, closed_at is not null as closed
			   from training_goals order by priority`
		)
	).toEqual([
		{ title: 'Valencia marathon', status: 'active', priority: 1, closed: false },
		{ title: 'Keep my strength', status: 'paused', priority: 2, closed: false },
		{ title: 'First Muay Thai fight', status: 'active', priority: 3, closed: false }
	]);
	expect(
		await query(
			`select change, source, count(*)::int as times from training_goal_events
			  group by change, source order by change`
		)
	).toEqual([
		{ change: 'created', source: 'profile', times: 3 },
		{ change: 'reprioritized', source: 'profile', times: 2 },
		{ change: 'status_changed', source: 'profile', times: 3 }
	]);
	expect(errors).toEqual([]);
});

test('deleting a goal takes a second tap that says it is for good; the goals below move up, and it is gone after a reload', async ({
	page,
	request,
	context
}, testInfo) => {
	// The one error expected is the browser's own, for the delete it could not post offline. Each
	// engine words it its own way (Chromium net::ERR_INTERNET_DISCONNECTED, WebKit “WebKit
	// encountered an internal error”), so it is told apart by the resource it names.
	const unsent: string[] = [];
	const errors = trackConsoleErrors(page, (msg) => {
		const at = new URL(msg.location().url || 'about:blank');
		const ours =
			msg.text().startsWith('Failed to load resource') &&
			`${at.pathname}${at.search}` === '/profile/goals?/deleteGoal';
		if (ours) unsent.push(msg.text());
		return ours;
	});
	await profileAction(request, '/profile/goals?/saveGoal', FIGHT);
	await profileAction(request, '/profile/goals?/saveGoal', MARATHON);
	await gotoHydrated(page, '/profile/goals');
	await editorReady(page);
	const sheet = sheetOf(page);
	const remove = sheet.getByTestId('goal-delete');
	const close = sheet.getByRole('button', { name: 'Close' });

	// A new goal has nothing to delete, and no status to change yet.
	await page.getByTestId('add-goal').click();
	await expect(sheet.getByRole('heading', { name: 'New goal' })).toBeVisible();
	await expect(remove).toHaveCount(0);
	await expect(statusOf(page)).toHaveCount(0);
	await close.click();
	await expect(sheet).toBeHidden();

	const rows = page.getByTestId('goal-row');
	await rows.first().click();
	await expect(remove).toHaveText('Delete goal');
	await remove.click();
	// The first tap only asks, and says what to do instead.
	await expect(remove).toHaveText('Delete for good');
	await expect(remove).toHaveAccessibleDescription(
		'Deleting can’t be undone. To keep it under Past goals, mark it achieved or dropped instead.'
	);
	await expect(sheet).toBeVisible();
	await expect(sheet.getByText('Deleting can’t be undone.', { exact: false })).toBeInViewport();
	expect(await query('select title from training_goals order by priority')).toEqual([
		{ title: 'First Muay Thai fight' },
		{ title: 'Valencia marathon' }
	]);
	await captureScreen(page, testInfo, 'goal-sheet-delete');

	// Closed, the sheet forgets it: the next time, Delete asks again.
	await close.click();
	await expect(sheet).toBeHidden();
	await rows.first().click();
	await expect(remove).toHaveText('Delete goal');
	await remove.click();
	await expect(remove).toHaveText('Delete for good');

	// Offline, nothing is deleted, the sheet says why and Delete keeps the keyboard focus.
	await context.setOffline(true);
	await remove.focus();
	await page.keyboard.press('Enter');
	await expect(sheet.getByTestId('goal-sheet-error')).toContainText('Can’t reach the server');
	await expect(remove).toBeFocused();
	await expect(rows).toHaveCount(2);
	await context.setOffline(false);

	await remove.click();
	await expect(toastWith(page, 'Goal deleted')).toBeVisible();
	await expect(sheet).toBeHidden();
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toHaveAccessibleName(/^Priority 1: Valencia marathon/);
	await expect(rows.first()).toContainText('Top priority');
	// Deleted is not past: it is gone.
	await expect(page.getByRole('region', { name: 'Past goals' })).toHaveCount(0);

	await page.reload();
	await editorReady(page);
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText('Valencia marathon');
	expect(await query('select title, priority from training_goals')).toEqual([
		{ title: 'Valencia marathon', priority: 1 }
	]);
	expect(
		await query(
			`select change, source, count(*)::int as times from training_goal_events
			  group by change, source order by change`
		)
	).toEqual([
		{ change: 'created', source: 'profile', times: 2 },
		{ change: 'deleted', source: 'profile', times: 1 },
		{ change: 'reprioritized', source: 'profile', times: 1 }
	]);
	expect(
		await query(
			`select snapshot->>'title' as title from training_goal_events where change = 'deleted'`
		)
	).toEqual([{ title: 'First Muay Thai fight' }]);
	// No error but the browser’s report of the one delete it could not post offline.
	expect(errors).toEqual([]);
	expect(unsent).toHaveLength(1);
});

test('a goal moves up the ranking by its arrow: the move is announced, and the order is stored and still there after a reload', async ({
	page,
	request
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	await threeGoals(request);
	await gotoHydrated(page, '/profile/goals');
	await editorReady(page);
	const rows = page.getByTestId('goal-row');
	const status = page.getByTestId('goal-order-status');
	await expect(rows.nth(2)).toHaveAccessibleName(/^Priority 3: Keep my strength/);

	await arrow(page, 'Keep my strength', 'up').click();
	await expect(rows.nth(1)).toHaveAccessibleName(/^Priority 2: Keep my strength/);
	await expect(status).toHaveText('Keep my strength is now priority 2 of 3');
	await arrow(page, 'Keep my strength', 'up').click();
	await expect(rows.first()).toHaveAccessibleName(/^Priority 1: Keep my strength/);
	await expect(rows.first()).toContainText('Top priority');
	await expect(rows.nth(1)).not.toContainText('Top priority');
	await expect(status).toHaveText('Keep my strength is now priority 1 of 3');
	await expect(arrow(page, 'Keep my strength', 'up')).toBeDisabled();
	await expect(arrow(page, 'First Muay Thai fight', 'up')).toBeEnabled();
	await expect
		.poll(storedRanking)
		.toEqual(['Keep my strength', 'First Muay Thai fight', 'Valencia marathon']);
	expect(
		await query(
			`select change, source, count(*)::int as times from training_goal_events
			  group by change, source order by change`
		)
	).toEqual([
		{ change: 'created', source: 'profile', times: 3 },
		// Each move re-ranks the two goals that swap places.
		{ change: 'reprioritized', source: 'profile', times: 4 }
	]);
	await captureScreen(page, testInfo, 'profile-goals-reordered');

	await page.reload();
	await editorReady(page);
	await expect(rows.first()).toHaveAccessibleName(/^Priority 1: Keep my strength/);
	await expect(rows.first()).toContainText('Top priority');
	await expect(rows.nth(1)).toHaveAccessibleName(/^Priority 2: First Muay Thai fight/);
	await expect(rows.nth(2)).toHaveAccessibleName(/^Priority 3: Valencia marathon/);
	expect(errors).toEqual([]);
});

test('by keyboard, focus stays with the goal that moves, the other arrow taking over at either end', async ({
	page,
	request
}) => {
	await threeGoals(request);
	await gotoHydrated(page, '/profile/goals');
	await editorReady(page);
	const rows = page.getByTestId('goal-row');

	await arrow(page, 'Valencia marathon', 'up').focus();
	await page.keyboard.press('Enter');
	await expect(rows.first()).toHaveAccessibleName(/^Priority 1: Valencia marathon/);
	// At the top it cannot go up again: focus moves to its other arrow instead of being lost.
	await expect(arrow(page, 'Valencia marathon', 'down')).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(rows.nth(1)).toHaveAccessibleName(/^Priority 2: Valencia marathon/);
	await expect(arrow(page, 'Valencia marathon', 'down')).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(rows.nth(2)).toHaveAccessibleName(/^Priority 3: Valencia marathon/);
	await expect(arrow(page, 'Valencia marathon', 'up')).toBeFocused();
	// Three moves in quick succession, stored one after another: the last one is what is kept.
	await expect
		.poll(storedRanking)
		.toEqual(['First Muay Thai fight', 'Keep my strength', 'Valencia marathon']);
	await expect(rows.nth(2)).toHaveAccessibleName(/^Priority 3: Valencia marathon/);
});

test('the top goal cannot go up nor the last one down, and every arrow is its own 44 px target, on a phone and on a desktop', async ({
	page,
	request
}, testInfo) => {
	await threeGoals(request);
	await gotoHydrated(page, '/profile/goals');
	await editorReady(page);
	const titles = ['First Muay Thai fight', 'Valencia marathon', 'Keep my strength'];
	await expect(arrow(page, titles[0]!, 'up')).toBeDisabled();
	await expect(arrow(page, titles[0]!, 'down')).toBeEnabled();
	await expect(arrow(page, titles[1]!, 'up')).toBeEnabled();
	await expect(arrow(page, titles[1]!, 'down')).toBeEnabled();
	await expect(arrow(page, titles[2]!, 'up')).toBeEnabled();
	await expect(arrow(page, titles[2]!, 'down')).toBeDisabled();
	// The up arrow is the down chevron turned over.
	const turn = (way: 'up' | 'down') =>
		arrow(page, titles[1]!, way)
			.locator('svg')
			.evaluate((svg) => {
				const m = new DOMMatrix(getComputedStyle(svg).transform);
				return [Math.round(m.a), Math.round(m.d)];
			});
	expect(await turn('up')).toEqual([-1, -1]);
	expect(await turn('down')).toEqual([1, 1]);

	type Box = { x: number; y: number; width: number; height: number };
	const apart = (a: Box, b: Box) =>
		a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
	for (const viewport of [null, { width: 1440, height: 900 }]) {
		if (viewport) await page.setViewportSize(viewport);
		const boxes: Box[] = [];
		for (const [i, title] of titles.entries()) {
			const up = (await arrow(page, title, 'up').boundingBox())!;
			const down = (await arrow(page, title, 'down').boundingBox())!;
			for (const box of [up, down]) {
				expect(box.width, title).toBeGreaterThanOrEqual(44);
				expect(box.height, title).toBeGreaterThanOrEqual(44);
			}
			boxes.push(up, down, (await page.getByTestId('goal-row').nth(i).boundingBox())!);
		}
		for (const [i, a] of boxes.entries()) {
			for (const b of boxes.slice(i + 1)) expect(apart(a, b), JSON.stringify([a, b])).toBe(true);
		}
		// Beside the goals, not past the edge of the screen.
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
		).toBe(true);
	}
	await captureScreen(page, testInfo, 'profile-goals-order-desktop');
});

test('goal saves, deletes and reorders belong to Goals, which has no Save of its own', async ({
	request
}) => {
	const post = (action: string, payload: unknown) =>
		request.post(action, {
			headers: { ...SAME_ORIGIN, accept: 'application/json', 'x-sveltekit-action': 'true' },
			multipart: { payload: JSON.stringify(payload) }
		});
	expect((await post('/profile/equipment?/saveGoal', FIGHT)).status()).toBe(404);
	expect((await post('/profile/goals?/save', FIGHT)).status()).toBe(404);
	expect(await query('select id from training_goals')).toEqual([]);

	await profileAction(request, '/profile/goals?/saveGoal', FIGHT);
	const [goal] = await query<{ id: string }>('select id from training_goals');
	expect((await post('/profile/equipment?/deleteGoal', { id: goal!.id })).status()).toBe(404);
	expect((await post('/profile/equipment?/reorderGoals', { ids: [goal!.id] })).status()).toBe(404);
	// A status changes through saveGoal: there is no action of its own.
	const achieved = { id: goal!.id, status: 'achieved' };
	expect((await post('/profile/goals?/goalStatus', achieved)).status()).toBe(404);
	expect(await query('select status, priority from training_goals')).toEqual([
		{ status: 'active', priority: 1 }
	]);
});

test('the page carries none of the editor’s styles: they arrive with the editor', async ({
	page,
	request
}) => {
	const styles = built(EDITOR).css ?? [];
	expect(styles.length).toBeGreaterThan(0);
	const html = await (await request.get('/profile/goals')).text();
	for (const file of styles) {
		// Neither linked nor inlined, so they never hold up the first paint.
		expect(html).not.toContain(path.basename(file));
		expect(html).not.toContain(readFileSync(`${CLIENT}/${file}`, 'utf8').trim().slice(0, 120));
	}
	await profileAction(request, '/profile/goals?/saveGoal', FIGHT);
	await gotoHydrated(page, '/profile/goals');
	await editorReady(page);
	const row = page.getByTestId('goal-row').first();
	expect(await row.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).not.toBe('0px');
});

test.describe('with the network in the test’s hands', () => {
	// page.route never sees a request the service worker answers, and it precaches every chunk.
	test.use({ serviceWorkers: 'block' });

	test('the sheet is not in the screen’s initial JS: it loads on first intent, and an early tap still opens it', async ({
		page
	}) => {
		const file = chunkFile(SHEET);
		const fetched: string[] = [];
		page.on('request', (r) => {
			if (new URL(r.url()).pathname === `/${file}`) fetched.push(r.url());
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		await page.route(`**/${file}`, async (route) => {
			await held;
			await route.continue();
		});
		await gotoHydrated(page, '/profile/goals');
		await editorReady(page);
		expect(fetched).toEqual([]);

		// The tap lands while the sheet is still on its way: it opens once it arrives.
		await page.getByTestId('goal-path-event').click();
		await expect.poll(() => fetched.length).toBe(1);
		await expect(sheetOf(page)).toBeHidden();
		release();
		await expect(sheetOf(page).getByRole('heading', { name: 'New goal' })).toBeVisible();
	});

	test('a reorder the server does not store puts the order back and says so; tried again, it saves', async ({
		page,
		request
	}) => {
		await threeGoals(request);
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		const reorder = (url: URL) => url.search === '?/reorderGoals';
		await page.route(reorder, async (route) => {
			await held;
			// What SvelteKit answers when an action throws.
			await route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ type: 'error', error: { message: 'Internal Error' } })
			});
		});
		await gotoHydrated(page, '/profile/goals');
		await editorReady(page);
		const rows = page.getByTestId('goal-row');

		await arrow(page, 'Valencia marathon', 'up').click();
		// The list moves before the server answers.
		await expect(rows.first()).toHaveAccessibleName(/^Priority 1: Valencia marathon/);
		release();
		const failed = toastWith(page, 'The new order didn’t save. Try again.');
		await expect(failed).toBeVisible();
		await expect(failed).toHaveAttribute('data-tone', 'danger');
		await expect(rows.first()).toHaveAccessibleName(/^Priority 1: First Muay Thai fight/);
		await expect(rows.first()).toContainText('Top priority');
		await expect(rows.nth(1)).toHaveAccessibleName(/^Priority 2: Valencia marathon/);
		await expect(page.getByTestId('goal-order-status')).toHaveText('');
		expect(await storedRanking()).toEqual([
			'First Muay Thai fight',
			'Valencia marathon',
			'Keep my strength'
		]);

		await page.unroute(reorder);
		await arrow(page, 'Valencia marathon', 'up').click();
		await expect
			.poll(storedRanking)
			.toEqual(['Valencia marathon', 'First Muay Thai fight', 'Keep my strength']);
		await expect(rows.first()).toHaveAccessibleName(/^Priority 1: Valencia marathon/);
	});

	test('a sheet that does not load says so, and Retry loads it', async ({ page }) => {
		const chunk = `**/${chunkFile(SHEET)}`;
		await page.route(chunk, (route) => route.abort());
		await gotoHydrated(page, '/profile/goals');
		await editorReady(page);
		await page.getByTestId('goal-path-event').click();
		await expect(page.getByTestId('goals-error')).toContainText('Goals can’t be edited right now');
		await expect(sheetOf(page)).toHaveCount(0);

		await page.unroute(chunk);
		await page.getByRole('button', { name: 'Retry' }).click();
		await editorReady(page);
		await expect(page.getByTestId('goals-error')).toHaveCount(0);
		await page.getByTestId('goal-path-event').click();
		await expect(sheetOf(page).getByRole('heading', { name: 'New goal' })).toBeVisible();
	});
});

for (const theme of ['dark', 'light'] as const) {
	test(`the ways in, the ranked and past goals, and an open goal of each kind with its status and Delete have no WCAG A/AA violations (${theme} theme)`, async ({
		page,
		request
	}) => {
		await page.addInitScript(
			(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
			theme
		);
		await gotoHydrated(page, '/profile/goals');
		await editorReady(page);
		await expect(page.getByTestId('goal-path-several')).toBeVisible();
		const audit = async () => {
			await page.evaluate(() => document.fonts.ready);
			await page.waitForTimeout(400);
			const { violations } = await new AxeBuilder({ page })
				.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
				.analyze();
			return violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
		};
		expect(await audit(), 'ways in').toEqual([]);

		await profileAction(request, '/profile/goals?/saveGoal', FIGHT);
		await profileAction(request, '/profile/goals?/saveGoal', { ...MARATHON, status: 'paused' });
		await profileAction(request, '/profile/goals?/saveGoal', { ...STRENGTH, status: 'achieved' });
		await profileAction(request, '/profile/goals?/saveGoal', {
			...FIGHT,
			title: 'Spring smoker',
			status: 'dropped'
		});
		await page.reload();
		await editorReady(page);
		await expect(page.getByTestId('goal-row')).toHaveCount(2);
		await expect(page.getByTestId('past-goal-row')).toHaveCount(2);
		expect(await audit(), 'list').toEqual([]);
		await page.getByTestId('goal-row').first().click();
		const sheet = sheetOf(page);
		await expect(sheet.getByRole('heading', { name: 'Edit goal' })).toBeVisible();
		await expect(statusOf(page)).toBeVisible();
		expect(await audit(), 'sheet').toEqual([]);
		await sheet.getByTestId('goal-delete').click();
		await expect(sheet.getByTestId('goal-delete')).toHaveText('Delete for good');
		expect(await audit(), 'delete').toEqual([]);
		// Not saved: the sheet only shows the general goal's fields.
		await sheet.getByRole('radio', { name: 'General' }).click();
		await expect(textbox(page, 'What to improve')).toBeVisible();
		expect(await audit(), 'general').toEqual([]);
	});
}
