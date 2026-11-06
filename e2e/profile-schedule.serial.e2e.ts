/**
 * Profile → Schedule (/profile/schedule): training days and session length on two steppers,
 * the days and times the owner can train, and the commitments already in the week. Serial (one
 * test at a time, after the functional suites): every test starts from a blank training
 * profile, which every browser and worker shares.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
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

const days = (page: Page) => page.getByRole('spinbutton', { name: 'Training days a week' });
const minutes = (page: Page) => page.getByRole('spinbutton', { name: 'Session length' });
/** Tap a stepper's − or + `times` times. */
async function step(page: Page, name: string, times: number) {
	const button = page.getByRole('button', { name });
	for (let i = 0; i < times; i++) await button.click();
}
const available = (page: Page, day: string) =>
	page.getByRole('group', { name: 'Days you can train' }).getByRole('checkbox', { name: day });
const save = (page: Page) => page.getByTestId('save-section');
const cards = (page: Page) => page.getByTestId('commitment');

/** Save and wait for the server's answer (an earlier save's toast may still be showing). */
async function saved(page: Page) {
	const answered = page.waitForResponse(
		(r) => r.request().method() === 'POST' && r.url().endsWith('/profile/schedule?/save')
	);
	await save(page).click();
	expect(await (await answered).json()).toMatchObject({ type: 'success' });
	await expect(toastWith(page, 'Saved').last()).toBeVisible();
}

/** Fill in one commitment card the way a thumb would. */
async function describeCommitment(
	card: Locator,
	c: { label: string; discipline?: string; days: string[]; time?: string; length?: string }
) {
	await card.getByRole('textbox', { name: 'What is it?' }).fill(c.label);
	if (c.discipline) {
		await card
			.getByRole('group', { name: 'Discipline' })
			.getByRole('radio', { name: c.discipline })
			.check();
	}
	const picker = card.getByRole('group', { name: 'Days', exact: true });
	for (const day of c.days) await picker.getByRole('checkbox', { name: day }).check();
	if (c.time)
		await card.getByRole('group', { name: 'Time' }).getByRole('radio', { name: c.time }).check();
	if (c.length) await card.getByRole('textbox', { name: /^Length/ }).fill(c.length);
}

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test('with nothing saved, Schedule suggests 4 days of 60 minutes and says so until changed', async ({
	page
}) => {
	const errors = trackConsoleErrors(page);
	await gotoHydrated(page, '/profile');
	const row = page
		.getByRole('region', { name: 'Training profile' })
		.getByRole('link', { name: /Schedule/ });
	await expect(row).toHaveAttribute('href', '/profile/schedule');
	await row.click();
	await expect(page).toHaveURL('/profile/schedule');
	await expect(page.getByRole('heading', { level: 1, name: 'Schedule' })).toBeVisible();
	await editorReady(page);

	await expect(days(page)).toHaveAttribute('aria-valuenow', '4');
	await expect(days(page)).toHaveAccessibleDescription(/^Suggested to start: keep it or change it/);
	await expect(minutes(page)).toHaveAttribute('aria-valuenow', '60');
	await expect(minutes(page)).toHaveAttribute('aria-valuetext', '60 min');
	await expect(minutes(page)).toHaveAccessibleDescription(/^Suggested to start/);
	await expect(page.getByTestId('no-commitments')).toBeVisible();

	// The suggestion never asks for more days than are free.
	for (const day of ['Monday', 'Wednesday', 'Friday']) await available(page, day).check();
	await expect(days(page)).toHaveAttribute('aria-valuenow', '3');
	await available(page, 'Friday').uncheck();
	await expect(days(page)).toHaveAttribute('aria-valuenow', '2');
	for (const day of ['Monday', 'Wednesday']) await available(page, day).uncheck();
	await expect(days(page)).toHaveAttribute('aria-valuenow', '4');

	// Changed, the number is the owner's own: no longer labelled a suggestion.
	await step(page, 'Increase Training days a week', 1);
	await expect(days(page)).toHaveAttribute('aria-valuenow', '5');
	await expect(days(page)).toHaveAccessibleDescription('Lifting, runs and classes all count.');
	await expect(minutes(page)).toHaveAccessibleDescription(/^Suggested to start/);

	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth
	}));
	expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
	expect(errors).toEqual([]);
});

test('5 days a week with only Mon, Wed and Fri free: the stepper’s error is announced and nothing saves', async ({
	page
}) => {
	await page.goto('/profile/schedule');
	await editorReady(page);
	for (const day of ['Monday', 'Wednesday', 'Friday']) await available(page, day).check();
	await step(page, 'Increase Training days a week', 2);
	await expect(days(page)).toHaveAttribute('aria-valuenow', '5');
	await save(page).click();

	const message = 'You picked 3 available days — fewer than 5 sessions';
	await expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible();
	await expect(days(page)).toHaveAttribute('aria-invalid', 'true');
	await expect(days(page)).toHaveAccessibleDescription(message);
	await expect(days(page)).toBeFocused();
	await expect(page.getByTestId('save-error')).toContainText('Check the highlighted fields.');
	await expect(toastWith(page, 'Saved')).toHaveCount(0);
	expect(await query('select days_per_week from schedules')).toEqual([]);

	await step(page, 'Decrease Training days a week', 2);
	await saved(page);
	await expect(page.getByRole('alert').filter({ hasText: message })).toHaveCount(0);
	await expect(days(page)).not.toHaveAttribute('aria-invalid');
	expect(await query('select days_per_week, available_days from schedules')).toEqual([
		{ days_per_week: 3, available_days: ['mon', 'wed', 'fri'] }
	]);
});

test('4 days on Tue, Thu, Sat and Sun, evenings, 75 minutes: stored, and still there after a reload', async ({
	page
}, testInfo) => {
	await page.goto('/profile/schedule');
	await editorReady(page);
	for (const day of ['Tuesday', 'Thursday', 'Saturday', 'Sunday'])
		await available(page, day).check();
	await page
		.getByRole('group', { name: 'Best times to train' })
		.getByRole('checkbox', { name: 'Evening' })
		.check();
	await step(page, 'Increase Session length', 3);
	await expect(minutes(page)).toHaveAttribute('aria-valuetext', '75 min');
	await page
		.getByRole('textbox', { name: /^Anything else about your schedule/ })
		.fill('Night shifts every other week');
	// The days stepper stays at the suggestion: Save keeps it, as shown.
	await expect(days(page)).toHaveAttribute('aria-valuenow', '4');
	await saved(page);
	expect(
		await query(
			'select days_per_week, available_days, preferred_times, session_minutes, constraints from schedules'
		)
	).toEqual([
		{
			days_per_week: 4,
			available_days: ['tue', 'thu', 'sat', 'sun'],
			preferred_times: ['evening'],
			session_minutes: 75,
			constraints: 'Night shifts every other week'
		}
	]);

	await page.reload();
	await editorReady(page);
	await expect(days(page)).toHaveAttribute('aria-valuenow', '4');
	await expect(days(page)).toHaveAccessibleDescription('Lifting, runs and classes all count.');
	await expect(minutes(page)).toHaveAttribute('aria-valuenow', '75');
	await expect(minutes(page)).toHaveAccessibleDescription('A typical session, warm-up included.');
	for (const day of ['Tuesday', 'Thursday', 'Saturday', 'Sunday']) {
		await expect(available(page, day)).toBeChecked();
	}
	await expect(available(page, 'Monday')).not.toBeChecked();
	await expect(
		page
			.getByRole('group', { name: 'Best times to train' })
			.getByRole('checkbox', { name: 'Evening' })
	).toBeChecked();
	await page.evaluate(() => scrollTo(0, 0));
	await captureScreen(page, testInfo, 'profile-schedule');
});

test('a Muay Thai class on Tue and Thu evenings, 90 minutes, hard: stored, reloaded, removed', async ({
	page
}, testInfo) => {
	await page.goto('/profile/schedule');
	await editorReady(page);
	await page.getByTestId('add-commitment').click();
	const card = cards(page).first();
	// Straight to the name of what was added.
	await expect(card.getByRole('textbox', { name: 'What is it?' })).toBeFocused();
	await describeCommitment(card, {
		label: 'Muay Thai class',
		discipline: 'Muay Thai',
		days: ['Thursday', 'Tuesday'],
		time: 'Evening',
		length: '90'
	});
	const intensity = card.getByRole('group', { name: 'Intensity' });
	// "Not sure" until one is picked, and the way back to none (radios cannot be cleared).
	await expect(intensity.getByRole('radio', { name: 'Not sure' })).toBeChecked();
	await intensity.getByRole('radio', { name: 'Hard' }).check();
	await expect(card.getByRole('heading', { level: 3, name: 'Muay Thai class' })).toBeVisible();
	await expect(card.getByText('Tue, Thu · evening · 90 min · hard')).toBeVisible();
	await card.evaluate((el) => el.scrollIntoView({ block: 'start' }));
	await captureScreen(page, testInfo, 'profile-schedule-commitment');

	await saved(page);
	const stored =
		'select id, discipline, label, days, time_of_day, duration_minutes, intensity from schedule_commitments';
	const [first] = await query<{ id: string }>(stored);
	expect(await query(stored)).toEqual([
		{
			id: first!.id,
			discipline: 'muay_thai',
			label: 'Muay Thai class',
			days: ['tue', 'thu'],
			time_of_day: 'evening',
			duration_minutes: 90,
			intensity: 'hard'
		}
	]);

	await page.reload();
	await editorReady(page);
	await expect(cards(page)).toHaveCount(1);
	await expect(card.getByRole('textbox', { name: 'What is it?' })).toHaveValue('Muay Thai class');
	await expect(card.getByRole('radio', { name: 'Muay Thai' })).toBeChecked();
	await expect(card.getByRole('checkbox', { name: 'Tuesday' })).toBeChecked();
	await expect(card.getByRole('checkbox', { name: 'Thursday' })).toBeChecked();
	await expect(
		card.getByRole('group', { name: 'Time' }).getByRole('radio', { name: 'Evening' })
	).toBeChecked();
	await expect(card.getByRole('textbox', { name: /^Length/ })).toHaveValue('90');
	await expect(intensity.getByRole('radio', { name: 'Hard' })).toBeChecked();

	// Back to "Not sure" stores no intensity; the same row is edited, not a new one.
	await intensity.getByRole('radio', { name: 'Not sure' }).check();
	await saved(page);
	expect(await query('select id, intensity from schedule_commitments')).toEqual([
		{ id: first!.id, intensity: null }
	]);

	await card.getByRole('button', { name: 'Remove Muay Thai class' }).click();
	await expect(cards(page)).toHaveCount(0);
	await expect(page.getByTestId('no-commitments')).toBeVisible();
	await expect(
		page.getByRole('status').filter({ hasText: 'Removed Muay Thai class' })
	).toBeAttached();
	await saved(page);
	expect(await query('select id from schedule_commitments')).toEqual([]);
});

test('saved twice without a reload, a new commitment stays the same row and the suggestion is kept', async ({
	page
}) => {
	await page.goto('/profile/schedule');
	await editorReady(page);
	await page.getByTestId('add-commitment').click();
	await describeCommitment(cards(page).first(), { label: 'Muay Thai class', days: ['Tuesday'] });
	await saved(page);
	const [first] = await query<{ id: string }>('select id from schedule_commitments');
	// Stored, the suggestion is the owner's answer now.
	await expect(days(page)).toHaveAccessibleDescription('Lifting, runs and classes all count.');

	await describeCommitment(cards(page).first(), { label: 'Muay Thai class', days: ['Thursday'] });
	await saved(page);
	expect(await query('select id, days from schedule_commitments')).toEqual([
		{ id: first!.id, days: ['tue', 'thu'] }
	]);
});

test('removing a commitment leaves every other card, and its errors, with its own commitment', async ({
	page
}) => {
	await page.goto('/profile/schedule');
	await editorReady(page);
	const add = page.getByTestId('add-commitment');
	await add.click();
	await describeCommitment(cards(page).nth(0), { label: 'Muay Thai class', days: ['Tuesday'] });
	await add.click();
	await describeCommitment(cards(page).nth(1), { label: 'Club run', days: [] });
	await add.click();
	await describeCommitment(cards(page).nth(2), { label: 'Yoga', days: ['Saturday'] });

	// The club run has no days: the browser refuses the save and the error is on its card.
	await save(page).click();
	const dayError = page.getByRole('alert').filter({ hasText: 'Pick at least one day' });
	await expect(dayError).toHaveCount(1);
	await expect(cards(page).nth(1).getByRole('alert')).toHaveText('Pick at least one day');
	expect(await query('select id from schedule_commitments')).toEqual([]);

	// The cards below the one removed are the same cards (nothing moved into them), and the
	// error stays with the club run.
	const clubRun = await cards(page).nth(1).elementHandle();
	const yoga = await cards(page).nth(2).elementHandle();
	const remove = cards(page).nth(0).getByRole('button', { name: 'Remove Muay Thai class' });
	await remove.focus();
	await page.keyboard.press('Enter');
	await expect(cards(page)).toHaveCount(2);
	expect(await clubRun!.evaluate((el) => el.isConnected)).toBe(true);
	expect(await yoga!.evaluate((el) => el.isConnected)).toBe(true);
	await expect(cards(page).nth(0).getByRole('textbox', { name: 'What is it?' })).toHaveValue(
		'Club run'
	);
	await expect(cards(page).nth(0).getByRole('alert')).toHaveText('Pick at least one day');
	await expect(cards(page).nth(1).getByRole('textbox', { name: 'What is it?' })).toHaveValue(
		'Yoga'
	);
	await expect(cards(page).nth(1).getByRole('alert')).toHaveCount(0);
	// Focus stays in the list, on the next card's Remove; the removal is announced.
	await expect(cards(page).nth(0).getByRole('button', { name: 'Remove Club run' })).toBeFocused();
	await expect(
		page.getByRole('status').filter({ hasText: 'Removed Muay Thai class' })
	).toBeAttached();

	await describeCommitment(cards(page).nth(0), { label: 'Club run', days: ['Wednesday'] });
	await saved(page);
	expect(await query('select label, days from schedule_commitments order by label')).toEqual([
		{ label: 'Club run', days: ['wed'] },
		{ label: 'Yoga', days: ['sat'] }
	]);
});
