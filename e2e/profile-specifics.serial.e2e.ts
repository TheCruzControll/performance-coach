/**
 * Profile → Running & Muay Thai: running volume, easy pace and race times, and Muay Thai
 * sessions, sparring and fights, each shown while its discipline is in play. Serial (one test at
 * a time, after the functional suites): every test starts from a blank training profile, which
 * every browser and worker shares.
 */
import AxeBuilder from '@axe-core/playwright';
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

/** The editor has loaded in place of the skeleton. */
async function editorReady(page: Page) {
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
}

const part = (page: Page, name: 'Running' | 'Muay Thai') =>
	page.getByRole('region', { name, exact: true });
const races = (page: Page) => page.getByTestId('race');
const raceNames = (page: Page) => races(page).getByRole('heading');
const field = (scope: Locator | Page, name: string) =>
	scope.getByRole('textbox', { name, exact: true });
const save = (page: Page) => page.getByTestId('save-section');

/** Add a race, pick its distance and type its time; the race, wherever it is in the list. */
async function addRace(page: Page, distance: string, time: string) {
	const place = await races(page).count();
	await page.getByRole('button', { name: 'Add a race' }).click();
	const race = races(page).nth(place);
	await race.getByRole('radio', { name: distance, exact: true }).check();
	await field(race, 'Time').fill(time);
	return race;
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
	const row = page
		.getByRole('region', { name: 'Training profile' })
		.getByRole('link', { name: /Running & Muay Thai/ });
	await expect(row).toHaveAttribute('href', '/profile/specifics');
	await row.click();
	await expect(page).toHaveURL('/profile/specifics');
	await expect(page.getByRole('heading', { level: 1, name: 'Running & Muay Thai' })).toBeVisible();
	await editorReady(page);
	await expect(part(page, 'Running')).toBeVisible();
	await expect(part(page, 'Muay Thai')).toBeVisible();
	await expect(page.getByTestId('specifics-empty')).toHaveCount(0);
	await expect(page.getByRole('button', { name: /^Add (running|Muay Thai)$/ })).toHaveCount(0);
	await expect(races(page)).toHaveCount(0);
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth
	}));
	expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
	expect(errors).toEqual([]);
});

test('times typed on the decimal keypad save in seconds, and read back written out', async ({
	page
}, testInfo) => {
	await seedGoals('running', 'muay_thai');
	await page.goto('/profile/specifics');
	await editorReady(page);
	const running = part(page, 'Running');
	await field(running, 'Weekly distance').fill('40');
	await field(running, 'Runs').fill('4');
	// The iPhone's decimal keypad has no ':', so a time is typed with its '.'.
	const pace = field(running, 'Easy pace');
	await expect(pace).toHaveAttribute('inputmode', 'decimal');
	await expect(page.getByText('m.ss per km, like 5.45')).toBeVisible();
	await pace.fill('5.45');

	const half = await addRace(page, 'Half marathon', '1.45.30');
	await expect(field(half, 'Time')).toHaveAttribute('inputmode', 'decimal');
	await half.getByLabel(/^When/).fill('2026-10-12');
	await expect(raceNames(page)).toHaveText(['Half marathon']);

	// An "Other" race needs to say how far it was: nothing is saved until it does.
	const other = await addRace(page, 'Other', '58.10');
	await save(page).click();
	await expect(other.getByRole('alert')).toHaveText('How far was it?');
	await expect(half.getByRole('alert')).toHaveCount(0);
	await expect(field(other, 'How far?')).toBeFocused();
	await expect(page.getByTestId('save-error')).toContainText('Check the highlighted fields');
	await field(other, 'How far?').fill('12');
	await expect(raceNames(page)).toHaveText(['Half marathon', '12 km']);

	// A time that is not one is refused on its own race, before anything is posted.
	const tenK = await addRace(page, '10K', 'abc');
	await save(page).click();
	await expect(tenK.getByRole('alert')).toHaveText('Type it as h.mm.ss or m.ss, like 1.45.30');
	await expect(races(page).getByRole('alert')).toHaveCount(1);
	expect(await stored()).toEqual({ running: [], races: [], muayThai: [] });
	await field(tenK, 'Time').fill('47.05');

	const muayThai = part(page, 'Muay Thai');
	await field(muayThai, 'Sessions').fill('3');
	await field(muayThai, 'Sparring').fill('1');
	await expect(field(muayThai, 'Fights')).toHaveAttribute('inputmode', 'numeric');
	await field(muayThai, 'Fights').fill('2');
	await save(page).click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	expect(await stored()).toEqual({
		running: [{ unit: 'km', weekly: 40, runs: 4, longest: null, pace: 345 }],
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
	await expect(pace).toHaveValue('5:45');
	await expect(raceNames(page)).toHaveText(['10K', '12 km', 'Half marathon']);
	for (const [i, time] of ['47:05', '58:10', '1:45:30'].entries()) {
		await expect(field(races(page).nth(i), 'Time')).toHaveValue(time);
	}
	await expect(races(page).nth(2).getByLabel(/^When/)).toHaveValue('2026-10-12');
	await expect(field(muayThai, 'Sessions')).toHaveValue('3');
	await expect(field(muayThai, 'Sparring')).toHaveValue('1');
	await expect(field(muayThai, 'Fights')).toHaveValue('2');

	// Nothing unsaved: leaving asks nothing.
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
	await page.goto('/profile/specifics');
	await editorReady(page);
	await expect(raceNames(page)).toHaveText(['5K', '10K', 'Half marathon']);
	const half = races(page).nth(2);
	await field(half, 'Time').fill('abc');
	await save(page).click();
	await expect(half.getByRole('alert')).toHaveText('Type it as h.mm.ss or m.ss, like 1.45.30');

	// The cards below stay the same elements, so nothing in them (half-typed text, say) moves.
	await half.evaluate((el) => el.setAttribute('data-kept', ''));
	await field(races(page).first(), 'Time').fill('22.30');
	const remove = page.getByRole('button', { name: 'Remove 10K' });
	await remove.focus();
	await page.keyboard.press('Enter');
	await expect(raceNames(page)).toHaveText(['5K', 'Half marathon']);
	await expect(races(page).nth(1)).toHaveAttribute('data-kept', '');
	// Its error stayed with it, and keyboard focus moved to the next race's Remove.
	await expect(races(page).nth(1).getByRole('alert')).toHaveText(
		'Type it as h.mm.ss or m.ss, like 1.45.30'
	);
	await expect(races(page).first().getByRole('alert')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Remove Half marathon' })).toBeFocused();
	await expect(page.getByRole('status').filter({ hasText: 'Removed 10K' })).toHaveCount(1);
	await expect(field(races(page).first(), 'Time')).toHaveValue('22.30');

	await field(races(page).nth(1), 'Time').fill('1 44 59');
	await save(page).click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	expect((await stored()).races).toEqual([
		{ distance: '5k', custom: null, seconds: 1350, raced_on: null },
		{ distance: 'half_marathon', custom: null, seconds: 6299, raced_on: null }
	]);
});

test('with neither in play the screen offers both, and what is added stays after a save', async ({
	page
}, testInfo) => {
	await page.goto('/profile/specifics');
	await editorReady(page);
	const empty = page.getByTestId('specifics-empty');
	await expect(empty).toContainText('No running or Muay Thai yet');
	await expect(empty.getByRole('button', { name: 'Add running' })).toBeVisible();
	await expect(empty.getByRole('button', { name: 'Add Muay Thai' })).toBeVisible();
	await expect(part(page, 'Running')).toHaveCount(0);
	await expect(part(page, 'Muay Thai')).toHaveCount(0);
	await captureScreen(page, testInfo, 'profile-specifics-empty');

	await empty.getByRole('button', { name: 'Add Muay Thai' }).click();
	await expect(empty).toHaveCount(0);
	const muayThai = part(page, 'Muay Thai');
	await expect(field(muayThai, 'Sessions')).toBeFocused();
	await expect(page.getByRole('status').filter({ hasText: 'Added Muay Thai' })).toHaveCount(1);
	// The other one can still be added.
	await expect(page.getByRole('button', { name: 'Add running' })).toBeVisible();
	await field(muayThai, 'Sessions').fill('2');
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
	await expect(field(part(page, 'Muay Thai'), 'Sessions')).toHaveValue('2');
	await expect(page.getByTestId('specifics-empty')).toHaveCount(0);
	await page.getByRole('button', { name: 'Add running' }).click();
	await expect(field(part(page, 'Running'), 'Weekly distance')).toBeFocused();
	await expect(page.getByRole('button', { name: /^Add (running|Muay Thai)$/ })).toHaveCount(0);
});

for (const theme of ['dark', 'light'] as const) {
	test(`both parts, a race and its errors have no WCAG A/AA violations (${theme})`, async ({
		page
	}, testInfo) => {
		await page.addInitScript(
			(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
			theme
		);
		await seedGoals('running', 'muay_thai');
		await page.goto('/profile/specifics');
		await editorReady(page);
		if (theme === 'light')
			await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await field(part(page, 'Running'), 'Easy pace').fill('5.5');
		const race = await addRace(page, 'Other', 'abc');
		await save(page).click();
		await expect(race.getByRole('alert')).toHaveCount(2);
		await expect(part(page, 'Running').getByRole('alert')).toHaveText('Type it as m.ss, like 5.45');
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(400);
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		expect(violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`))).toEqual(
			[]
		);
		await captureScreen(page, testInfo, `profile-specifics-errors-${theme}`);
	});
}
