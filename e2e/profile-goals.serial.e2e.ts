/**
 * Profile → Goals: event goals ranked by priority, added and edited in a code-split sheet, each
 * saved the moment it changes (the screen has no Save bar). Serial (one test at a time, after the
 * functional suites): every test starts from a blank training profile, which every browser and
 * worker shares.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
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

/** The editor has loaded in place of the skeleton. */
async function editorReady(page: Page) {
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
}

const sheetOf = (page: Page) => page.getByTestId('goal-sheet');
const textbox = (page: Page, name: string | RegExp) =>
	sheetOf(page).getByRole('textbox', { name, exact: typeof name === 'string' });

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

test('goal saves belong to Goals, which has no Save of its own', async ({ request }) => {
	const post = (action: string) =>
		request.post(action, {
			headers: { ...SAME_ORIGIN, accept: 'application/json', 'x-sveltekit-action': 'true' },
			multipart: { payload: JSON.stringify(FIGHT) }
		});
	expect((await post('/profile/equipment?/saveGoal')).status()).toBe(404);
	expect((await post('/profile/goals?/save')).status()).toBe(404);
	expect(await query('select id from training_goals')).toEqual([]);
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
	test(`the ranked list and an open goal have no WCAG A/AA violations (${theme} theme)`, async ({
		page,
		request
	}) => {
		await page.addInitScript(
			(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
			theme
		);
		await profileAction(request, '/profile/goals?/saveGoal', FIGHT);
		await profileAction(request, '/profile/goals?/saveGoal', MARATHON);
		await gotoHydrated(page, '/profile/goals');
		await editorReady(page);
		await expect(page.getByTestId('goal-row')).toHaveCount(2);
		const audit = async () => {
			await page.evaluate(() => document.fonts.ready);
			await page.waitForTimeout(400);
			const { violations } = await new AxeBuilder({ page })
				.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
				.analyze();
			return violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
		};
		expect(await audit(), 'list').toEqual([]);
		await page.getByTestId('goal-row').first().click();
		await expect(sheetOf(page).getByRole('heading', { name: 'Edit goal' })).toBeVisible();
		expect(await audit(), 'sheet').toEqual([]);
	});
}
