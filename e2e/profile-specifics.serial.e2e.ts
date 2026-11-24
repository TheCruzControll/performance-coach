/**
 * Profile → Running and Muay Thai: running volume, easy pace, heart rate and race times, and
 * Muay Thai sessions, sparring and fights, each shown while its discipline is in play. Each
 * figure is a row that opens a short sheet of fields; Recent races is a sub-screen of race rows,
 * each race a sheet. Serial (one test at a time, after the functional suites): every test starts
 * from a blank training profile, which every browser and worker shares.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DESKTOP, expectNoSideScroll } from './desktop';
import {
	captureScreen,
	gotoHydrated,
	openSheet,
	profileAction,
	query,
	resetTrainingProfile,
	toastWith,
	trackConsoleErrors
} from './support';

/**
 * Open goals in these disciplines, ranked in this order. Nothing saves a goal from a screen yet,
 * so they go straight into the table the goal services write.
 */
async function seedGoals(...disciplines: string[]) {
	for (const [i, discipline] of disciplines.entries()) {
		await query(
			`insert into training_goals (owner_id, kind, title, disciplines, priority, focus)
			 select id, 'general', $1, $2::text[], $3, 'Get better at it' from owners`,
			[`Goal ${i + 1}`, [discipline], i + 1]
		);
	}
}

/** What is stored, numbers as numbers: running, its races (shortest first) and Muay Thai. */
async function stored() {
	return {
		running: await query(
			`select unit, weekly_distance::float8 as weekly, runs_per_week::float8 as runs,
			        longest_run::float8 as longest, easy_pace_seconds as pace
			 from running_profiles`
		),
		races: await query(
			`select distance, custom_distance::float8 as custom, time_seconds as seconds,
			        raced_on::text as raced_on
			 from race_results order by distance_metres`
		),
		muayThai: await query(
			`select sessions_per_week::float8 as sessions, sparring_per_week::float8 as sparring, fights
			 from muay_thai_profiles`
		)
	};
}

/** The editor has loaded under the title. */
async function editorReady(page: Page) {
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
}

const part = (page: Page, name: 'Running' | 'Heart rate' | 'Muay Thai') =>
	page.getByRole('region', { name, exact: true });
/** The race rows on Recent races, and their titles (each race's distance). */
const races = (page: Page) => page.getByTestId('race');
const raceNames = (page: Page) => races(page).locator('.title');
const field = (scope: Locator | Page, name: string) =>
	scope.getByRole('textbox', { name, exact: true });
const save = (page: Page) => page.getByTestId('save-section');
const TIME_FORMAT = 'Type it as h.mm.ss or m.ss, like 1.45.30';

/** Close the open sheet as a phone's keyboard or a desk's does; what was typed stays. */
async function closeSheet(page: Page, sheet: Locator) {
	await page.keyboard.press('Escape');
	await expect(sheet).toBeHidden();
}

/** Open a SheetRow in `scope`, fill its fields by name, and close it. */
async function fillSheet(
	page: Page,
	scope: Locator,
	label: string,
	fields: Record<string, string>,
	title?: string
) {
	const sheet = await openSheet(scope, page, label, title);
	for (const [name, text] of Object.entries(fields)) await field(sheet, name).fill(text);
	await closeSheet(page, sheet);
}

/** Recent races, from the Running group: a screen of its own, with its way back. */
async function openRaces(page: Page) {
	await page.getByTestId('races-row').click();
	await expect(page.getByRole('heading', { level: 1, name: 'Recent races' })).toBeFocused();
	await expect(page.getByTestId('sub-back')).toHaveText('Running and Muay Thai');
}

/** The open race's sheet: one race's at a time. */
const raceSheet = (page: Page) => page.getByRole('dialog', { name: 'A recent race' });

/** Add a race on Recent races: its sheet opens at once; pick its distance and type its time. */
async function addRace(page: Page, distance: string, time: string) {
	await page.getByTestId('add-race').click();
	const sheet = raceSheet(page);
	await expect(sheet).toBeVisible();
	await sheet.getByRole('radio', { name: distance, exact: true }).check();
	await field(sheet, 'Your time').fill(time);
	return sheet;
}

/** Open the race in this place on Recent races. */
async function openRace(page: Page, place: number) {
	await races(page).nth(place).click();
	const sheet = raceSheet(page);
	await expect(sheet).toBeVisible();
	return sheet;
}

/** A row's error is one red line under it, and the row is marked invalid and says why. */
async function expectRowError(row: Locator, message: string) {
	await expect(row).toHaveAttribute('aria-invalid', 'true');
	await expect(row).toHaveAccessibleDescription(message);
	await expect(row.locator('..').getByText(message, { exact: true })).toBeVisible();
}

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test('Profile lists the section, and running and Muay Thai goals bring both parts', async ({
	page
}) => {
	const errors = trackConsoleErrors(page);
	await seedGoals('distance_running', 'muay_thai');
	await gotoHydrated(page, '/profile');
	const row = page.getByTestId('section-specifics');
	await expect(row).toHaveAttribute('href', '/profile/specifics');
	await row.click();
	await expect(page).toHaveURL('/profile/specifics');
	await expect(
		page.getByRole('heading', { level: 1, name: 'Running and Muay Thai' })
	).toBeVisible();
	await editorReady(page);
	await expect(part(page, 'Running')).toBeVisible();
	await expect(part(page, 'Heart rate')).toBeVisible();
	await expect(part(page, 'Muay Thai')).toBeVisible();
	await expect(page.getByTestId('specifics-empty')).toHaveCount(0);
	await expect(page.getByRole('button', { name: /^Add (running|Muay Thai)$/ })).toHaveCount(0);
	// Each figure is a row with its answer, "Add" until there is one; no races says None.
	await expect(page.getByTestId('run-week')).toHaveAccessibleName(/^A usual week\s*Add$/);
	await expect(page.getByTestId('races-row')).toHaveAccessibleName(/^Recent races\s*None$/);
	await expect(page.getByTestId('hr-max')).toHaveAccessibleName(/^Max\s*Add$/);
	await expect(page.getByTestId('mt-fights')).toHaveAccessibleName(/^Fights so far\s*Add$/);
	await expectNoSideScroll(page);
	expect(errors).toEqual([]);
});

test('times typed on the decimal keypad save in seconds, and read back written out', async ({
	page
}, testInfo) => {
	await seedGoals('running', 'muay_thai');
	await gotoHydrated(page, '/profile/specifics');
	await editorReady(page);
	const running = part(page, 'Running');
	await fillSheet(page, running, 'A usual week', { 'Weekly distance': '24', Runs: '3' });
	await expect(page.getByTestId('run-week')).toHaveAccessibleName(
		/^A usual week\s*\d+ km in \d+ runs$/
	);
	// The iPhone's decimal keypad has no ':', so a time is typed with its '.'.
	const paceSheet = await openSheet(running, page, 'Easy pace');
	const pace = field(paceSheet, 'Easy pace');
	await expect(pace).toHaveAttribute('inputmode', 'decimal');
	await expect(paceSheet.getByText('m.ss per km, like 5.45')).toBeVisible();
	await pace.fill('5.45');
	await closeSheet(page, paceSheet);
	await expect(page.getByTestId('run-pace')).toHaveAccessibleName(/^Easy pace\s*5:45 a km$/);
	const heartRate = part(page, 'Heart rate');
	await fillSheet(page, heartRate, 'Max', { 'Max heart rate': '188' }, 'Max heart rate');
	await expect(page.getByTestId('hr-max')).toHaveAccessibleName(/^Max\s*188 bpm$/);

	await openRaces(page);
	const half = await addRace(page, 'Half marathon', '1.45.30');
	await expect(field(half, 'Your time')).toHaveAttribute('inputmode', 'decimal');
	await half.getByLabel(/^When/).fill('2026-10-12');
	await closeSheet(page, half);
	await expect(raceNames(page)).toHaveText(['Half marathon']);
	// The new race's sheet opened from its row, so the focus is back there.
	await expect(races(page).first()).toBeFocused();

	// Another distance needs to say how far it was: nothing is saved until it does.
	await closeSheet(page, await addRace(page, 'Another distance', '58.10'));
	await save(page).click();
	await expectRowError(races(page).nth(1), 'How far was it?');
	await expect(races(page).first()).not.toHaveAttribute('aria-invalid');
	await expect(races(page).nth(1)).toBeFocused();
	await expect(page.getByTestId('save-error')).toContainText('Check the highlighted fields');
	const other = await openRace(page, 1);
	await expect(other.getByRole('alert')).toHaveText('How far was it?');
	await field(other, 'How far?').fill('12');
	await closeSheet(page, other);
	await expect(raceNames(page)).toHaveText(['Half marathon', '12 km']);

	// A time that is not one is refused on its own race, before anything is posted.
	await closeSheet(page, await addRace(page, '10K', 'abc'));
	await save(page).click();
	await expectRowError(races(page).nth(2), TIME_FORMAT);
	await expect(page.locator('[data-testid="race"][aria-invalid="true"]')).toHaveCount(1);
	expect(await stored()).toEqual({ running: [], races: [], muayThai: [] });
	const tenK = await openRace(page, 2);
	await expect(tenK.getByRole('alert')).toHaveText(TIME_FORMAT);
	await field(tenK, 'Your time').fill('47.05');
	await closeSheet(page, tenK);

	// Back on the section, the focus is on the row that opened the races.
	await page.getByTestId('sub-back').click();
	await expect(page.getByTestId('races-row')).toBeFocused();
	await expect(page.getByTestId('races-row')).toHaveAccessibleName(/^Recent races\s*3 races$/);

	const muayThai = part(page, 'Muay Thai');
	await fillSheet(page, muayThai, 'A usual week', { Sessions: '3', Sparring: '1' });
	await expect(page.getByTestId('mt-week')).toHaveAccessibleName(
		/^A usual week\s*3 sessions, 1 sparring$/
	);
	const fights = await openSheet(muayThai, page, 'Fights so far');
	await expect(field(fights, 'Fights')).toHaveAttribute('inputmode', 'numeric');
	await field(fights, 'Fights').fill('2');
	await closeSheet(page, fights);
	await save(page).click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	expect(await stored()).toEqual({
		running: [{ unit: 'km', weekly: 24, runs: 3, longest: null, pace: 345 }],
		races: [
			{ distance: '10k', custom: null, seconds: 2825, raced_on: null },
			{ distance: 'other', custom: 12, seconds: 3490, raced_on: null },
			{ distance: 'half_marathon', custom: null, seconds: 6330, raced_on: '2026-10-12' }
		],
		muayThai: [{ sessions: 3, sparring: 1, fights: 2 }]
	});
	await page.evaluate(() => scrollTo(0, 0));
	await captureScreen(page, testInfo, 'profile-specifics');

	await page.reload();
	await editorReady(page);
	await expect(page.getByTestId('run-week')).toHaveAccessibleName(
		/^A usual week\s*24 km in 3 runs$/
	);
	await expect(page.getByTestId('run-pace')).toHaveAccessibleName(/^Easy pace\s*5:45 a km$/);
	await expect(page.getByTestId('hr-max')).toHaveAccessibleName(/^Max\s*188 bpm$/);
	await expect(page.getByTestId('mt-week')).toHaveAccessibleName(
		/^A usual week\s*3 sessions, 1 sparring$/
	);
	await expect(page.getByTestId('mt-fights')).toHaveAccessibleName(/^Fights so far\s*2$/);
	const paceAgain = await openSheet(running, page, 'Easy pace');
	await expect(field(paceAgain, 'Easy pace')).toHaveValue('5:45');
	await closeSheet(page, paceAgain);
	await openRaces(page);
	await expect(raceNames(page)).toHaveText(['10K', '12 km', 'Half marathon']);
	for (const [i, time] of ['47:05', '58:10', '1:45:30'].entries()) {
		await expect(races(page).nth(i)).toHaveAccessibleName(new RegExp(`\\s*${time}$`));
	}
	const halfAgain = await openRace(page, 2);
	await expect(field(halfAgain, 'Your time')).toHaveValue('1:45:30');
	await expect(halfAgain.getByLabel(/^When/)).toHaveValue('2026-10-12');
	await closeSheet(page, halfAgain);

	// Nothing unsaved: leaving asks nothing.
	await page.getByTestId('sub-back').click();
	await page.getByTestId('back-to-profile').click();
	await expect(page).toHaveURL('/profile');
});

test('removing a race in the middle leaves the others as they were, errors included', async ({
	page,
	request
}) => {
	await seedGoals('running');
	await profileAction(request, '/profile/specifics?/save', {
		running: {
			unit: 'km',
			races: [
				{ distance: '5k', timeSeconds: 1360 },
				{ distance: '10k', timeSeconds: 2825 },
				{ distance: 'half_marathon', timeSeconds: 6330 }
			]
		},
		muayThai: null
	});
	await gotoHydrated(page, '/profile/specifics');
	await editorReady(page);
	await expect(page.getByTestId('races-row')).toHaveAccessibleName(/^Recent races\s*3 races$/);
	await openRaces(page);
	await expect(raceNames(page)).toHaveText(['5K', '10K', 'Half marathon']);
	const halfSheet = await openRace(page, 2);
	await field(halfSheet, 'Your time').fill('abc');
	await closeSheet(page, halfSheet);
	await save(page).click();
	await expectRowError(races(page).nth(2), TIME_FORMAT);

	// The rows below stay the same elements, so nothing in them (half-typed text, say) moves.
	await races(page)
		.nth(2)
		.evaluate((el) => el.setAttribute('data-kept', ''));
	const fiveK = await openRace(page, 0);
	await field(fiveK, 'Your time').fill('22.30');
	await closeSheet(page, fiveK);
	const tenK = await openRace(page, 1);
	await tenK.getByTestId('race-remove').click();
	await expect(tenK).toBeHidden();
	await expect(raceNames(page)).toHaveText(['5K', 'Half marathon']);
	await expect(races(page).nth(1)).toHaveAttribute('data-kept', '');
	// Its error stayed with it, and the focus stayed in the list.
	await expectRowError(races(page).nth(1), TIME_FORMAT);
	await expect(races(page).first()).not.toHaveAttribute('aria-invalid');
	// Removing index 1 leaves Half marathon at index 1, and removeRace focuses rows[1].
	await expect(races(page).nth(1)).toBeFocused();
	await expect(page.getByRole('status').filter({ hasText: 'Removed 10K' })).toHaveCount(1);
	await expect(races(page).first()).toHaveAccessibleName(/^5K\s*22\.30$/);

	const halfAgain = await openRace(page, 1);
	await field(halfAgain, 'Your time').fill('1 44 59');
	await closeSheet(page, halfAgain);
	await save(page).click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	expect((await stored()).races).toEqual([
		{ distance: '5k', custom: null, seconds: 1350, raced_on: null },
		{ distance: 'half_marathon', custom: null, seconds: 6299, raced_on: null }
	]);
	// Saved, Recent races stays open, its rows now what was stored.
	await expect(page.getByRole('heading', { level: 1, name: 'Recent races' })).toBeVisible();
	await expect(raceNames(page)).toHaveText(['5K', 'Half marathon']);
});

test('with neither in play the screen offers both, and what is added stays after a save', async ({
	page
}, testInfo) => {
	await gotoHydrated(page, '/profile/specifics');
	await editorReady(page);
	const empty = page.getByTestId('specifics-empty');
	await expect(empty).toContainText('If you also run or train Muay Thai, add it');
	await expect(empty.getByRole('button', { name: 'Add running' })).toBeVisible();
	await expect(empty.getByRole('button', { name: 'Add Muay Thai' })).toBeVisible();
	await expect(part(page, 'Running')).toHaveCount(0);
	await expect(part(page, 'Muay Thai')).toHaveCount(0);
	await captureScreen(page, testInfo, 'profile-specifics-empty');

	await empty.getByRole('button', { name: 'Add Muay Thai' }).click();
	await expect(empty).toHaveCount(0);
	await expect(page.getByTestId('mt-week')).toBeFocused();
	await expect(page.getByRole('status').filter({ hasText: 'Added Muay Thai' })).toHaveCount(1);
	// The other one can still be added.
	await expect(page.getByRole('button', { name: 'Add running' })).toBeVisible();
	await fillSheet(page, part(page, 'Muay Thai'), 'A usual week', { Sessions: '2' });
	await save(page).click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	// Running was never shown, so the save left it as it was: not there.
	expect(await stored()).toEqual({
		running: [],
		races: [],
		muayThai: [{ sessions: 2, sparring: null, fights: null }]
	});

	// Saved, it is part of the screen with no goal in it.
	await page.reload();
	await editorReady(page);
	await expect(page.getByTestId('mt-week')).toHaveAccessibleName(/^A usual week\s*2 sessions$/);
	await expect(page.getByTestId('specifics-empty')).toHaveCount(0);
	await page.getByRole('button', { name: 'Add running' }).click();
	await expect(page.getByTestId('run-week')).toBeFocused();
	await expect(page.getByRole('button', { name: /^Add (running|Muay Thai)$/ })).toHaveCount(0);
});

test.describe('at a desk', () => {
	test.use(DESKTOP);

	test('Recent races opens in the column with its way back, and a race is the centred dialog', async ({
		page
	}) => {
		await seedGoals('running');
		await gotoHydrated(page, '/profile/specifics');
		await editorReady(page);
		await openRaces(page);
		await expect(page.getByTestId('sub-back')).toBeVisible();
		const sheet = await addRace(page, '5K', '22.40');
		await expect(sheet).toHaveClass(/\bvisible\b/);
		const panel = sheet.locator('.sheet');
		await expect.poll(() => panel.evaluate((el) => el.getAnimations().length)).toBe(0);
		const [box, window] = [(await panel.boundingBox())!, (await sheet.boundingBox())!];
		expect(Math.abs(box.x + box.width / 2 - (window.x + window.width / 2))).toBeLessThanOrEqual(2);
		await closeSheet(page, sheet);
		await expect(races(page)).toHaveAccessibleName(/^5K\s*22\.40$/);
		await expectNoSideScroll(page);
	});
});

for (const theme of ['dark', 'light'] as const) {
	test(`the rows, a race and their errors have no WCAG A/AA violations (${theme})`, async ({
		page
	}, testInfo) => {
		await page.addInitScript(
			(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
			theme
		);
		await seedGoals('running', 'muay_thai');
		await gotoHydrated(page, '/profile/specifics');
		await editorReady(page);
		if (theme === 'light')
			await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await fillSheet(page, part(page, 'Running'), 'Easy pace', { 'Easy pace': '5.5' });
		await openRaces(page);
		await closeSheet(page, await addRace(page, 'Another distance', 'abc'));
		await save(page).click();
		await expect(races(page)).toHaveAttribute('aria-invalid', 'true');
		const audit = async () => {
			await page.evaluate(() => document.fonts.ready);
			await page.waitForTimeout(400);
			const { violations } = await new AxeBuilder({ page })
				.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
				.analyze();
			return violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
		};
		// The race's sheet, open on its two errors.
		const race = await openRace(page, 0);
		await expect(race.getByRole('alert')).toHaveCount(2);
		expect(await audit()).toEqual([]);
		await closeSheet(page, race);
		// The section: the easy pace marked, and Recent races saying it needs an answer.
		await page.getByTestId('sub-back').click();
		await expectRowError(page.getByTestId('run-pace'), 'Type it as m.ss, like 5.45');
		await expect(page.getByTestId('races-row')).toHaveAccessibleName(
			/^Recent races\s*Needs an answer$/
		);
		expect(await audit()).toEqual([]);
		await captureScreen(page, testInfo, `profile-specifics-errors-${theme}`);
	});
}
