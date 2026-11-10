/**
 * The workout settings (PRD §8) and Train's standalone rest timer. The settings sheet opens from
 * the workout menu, over it: the rest per exercise type when a prescription names none, whether
 * a completed set starts the rest, the tone, the vibration and keep-awake, each hidden where the
 * browser lacks it. Every change is kept on this device (localStorage pc:workout:v1) and the
 * workout reads it at its next set. Train → Tools → Rest timer runs the same timer on timestamps
 * this device keeps (pc:rest:v1): it survives a reload and opens no workout.
 *
 * The workout comes from the shared kit fixture seeded in IndexedDB; sync is held ('hold'), so
 * nothing here writes Postgres. Time is Playwright's clock, paused once the page is ready, so
 * every reading is exact (Train's holds the time of day instead, its timers running). The desktop
 * dialogs are workout-settings.desktop.e2e.ts.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { StrengthKit } from '../src/lib/domain/workout';
import { captureScreen } from './support';
import { gotoWorkout, seedWorkout, workoutDay } from './workout-support';

let kit: StrengthKit;
test.beforeAll(async () => {
	kit = (await workoutDay()).strength;
});

const THEMES = ['dark', 'light'] as const;

const card = (page: Page) => page.getByTestId('workout-main').getByTestId('exercise');
const heading = (page: Page) => card(page).getByRole('heading', { level: 2 });
const logger = (page: Page) => page.getByTestId('set-logger');
const pill = (page: Page) => page.getByTestId('rest-timer');
const time = (page: Page) => pill(page).getByTestId('rest-time');
const menu = (page: Page) => page.getByTestId('workout-menu');
const settings = (page: Page) => page.getByTestId('workout-settings');
const restSetting = (page: Page, restClass: string) =>
	settings(page).getByTestId(`rest-${restClass}`).getByRole('spinbutton');
const toggle = (page: Page, key: string) => settings(page).getByTestId(`setting-${key}`);
const stored = (page: Page, key: string) =>
	page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), key);

/**
 * The fixture with the leg press and the Romanian deadlift as isolation exercises: the leg
 * press with no prescribed rest, the deadlift keeping its prescribed 2:00.
 */
function isolationKit(): StrengthKit {
	const copy = structuredClone(kit);
	for (const slot of copy.exercises) {
		if (slot.exercise.name === 'Leg press') {
			slot.exercise.restClass = 'isolation';
			slot.sets = slot.sets.map((set) => ({ ...set, restSeconds: null }));
		}
		if (slot.exercise.name === 'Romanian deadlift') slot.exercise.restClass = 'isolation';
	}
	return copy;
}

/** Seeds `seed`, opens /workout with the clock installed, and waits for the store. */
async function open(page: Page, seed: StrengthKit = kit) {
	await page.clock.install();
	await seedWorkout(page, seed);
	await gotoWorkout(page);
	await expect(page.locator('main#main[data-store]')).toBeAttached();
	await expect(logger(page)).toBeVisible();
}

/** Time stands still from here: each step moves it on by hand. */
async function pause(page: Page) {
	await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
}

async function goTo(page: Page, name: string) {
	while ((await heading(page).textContent())?.trim() !== name) {
		await page.getByTestId('exercise-next').click();
	}
	await expect(heading(page)).toHaveText(name);
}

/** Completes the set at hand at `kg`. */
async function logSet(page: Page, kg: string) {
	const load = logger(page).getByTestId('logger-load').getByRole('spinbutton');
	if ((await load.inputValue()) !== kg) {
		await load.click();
		await load.fill(kg);
		await load.press('Enter');
	}
	await logger(page).getByTestId('complete-set').click();
}

/** The workout menu, then Settings over it. */
async function openSettings(page: Page) {
	await page.getByTestId('workout-menu-button').click();
	await expect(menu(page)).toBeVisible();
	await menu(page).getByTestId('menu-settings').click();
	await expect(settings(page)).toBeVisible();
}

/** Closes the settings, back to the menu, then the menu. */
async function closeSettings(page: Page) {
	await settings(page).getByRole('button', { name: 'Close' }).click();
	await expect(settings(page)).toBeHidden();
	await expect(menu(page).getByTestId('menu-settings')).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(menu(page)).toBeHidden();
}

async function audit(page: Page): Promise<string[]> {
	await page.waitForFunction(() => document.fonts.status === 'loaded');
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) =>
		v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
	);
}

test.describe('the workout settings (IndexedDB only)', () => {
	// gotoWorkout holds /api/workouts/* with page.route, which WebKit applies only without a worker.
	test.use({ serviceWorkers: 'block' });

	test('isolation rest at 1:00: an isolation exercise with no prescribed rest starts at 1:00, a prescribed rest still wins', async ({
		page
	}) => {
		await open(page, isolationKit());
		await openSettings(page);
		await expect(restSetting(page, 'isolation')).toHaveValue('1:30');
		await restSetting(page, 'isolation').click();
		await restSetting(page, 'isolation').fill('1:00');
		await restSetting(page, 'isolation').press('Enter');
		await expect(restSetting(page, 'isolation')).toHaveAttribute('aria-valuenow', '60');
		await expect
			.poll(() => stored(page, 'pc:workout:v1'))
			.toMatchObject({
				rest: { main: 180, compound: 120, isolation: 60, timed: 60 }
			});
		await closeSettings(page);

		await pause(page);
		await goTo(page, 'Leg press');
		await logSet(page, '120');
		await expect(pill(page)).toHaveAttribute('data-phase', 'running');
		await expect(time(page)).toHaveText('1:00');
		await pill(page).getByRole('button', { name: 'Skip' }).click();
		await expect(pill(page)).toHaveCount(0);

		await goTo(page, 'Romanian deadlift');
		await logSet(page, '100');
		await expect(time(page)).toHaveText('2:00');
	});

	test('auto-start off: a completed set starts no timer, and the settings persist across a reload', async ({
		page
	}) => {
		await open(page);
		await openSettings(page);
		const autoStart = toggle(page, 'autoStartRest');
		await expect(autoStart).toBeChecked();
		await autoStart.click();
		await expect(autoStart).not.toBeChecked();
		await restSetting(page, 'main').click();
		await restSetting(page, 'main').fill('4:00');
		await restSetting(page, 'main').press('Enter');
		await closeSettings(page);

		await pause(page);
		await goTo(page, 'Leg press');
		await logSet(page, '120');
		await expect(page.getByTestId('start-rest')).toBeVisible();
		await expect(pill(page)).toHaveCount(0);

		await page.reload();
		await expect(page.locator('main#main[data-ready]')).toBeAttached();
		await page.clock.runFor(2_000);
		await expect(page.locator('main#main[data-store]')).toBeAttached();
		await expect(pill(page)).toHaveCount(0);
		await openSettings(page);
		await expect(toggle(page, 'autoStartRest')).not.toBeChecked();
		await expect(restSetting(page, 'main')).toHaveValue('4:00');
		await expect(restSetting(page, 'isolation')).toHaveValue('1:30');
	});

	test('each feedback shows only where the browser has it: vibration is hidden on WebKit', async ({
		page,
		browserName
	}) => {
		await open(page);
		await openSettings(page);
		await expect(toggle(page, 'autoStartRest')).toBeVisible();
		const has = await page.evaluate(() => ({
			vibration: typeof navigator.vibrate === 'function',
			wakeLock: typeof navigator.wakeLock?.request === 'function'
		}));
		if (browserName === 'webkit') expect(has.vibration).toBe(false);
		await expect(toggle(page, 'vibration')).toHaveCount(has.vibration ? 1 : 0);
		await expect(toggle(page, 'keepAwake')).toHaveCount(has.wakeLock ? 1 : 0);
		await expect(toggle(page, 'sound')).toHaveCount(1);
		if (browserName === 'chromium') await expect(toggle(page, 'vibration')).toBeVisible();
	});

	for (const theme of THEMES) {
		test(`no WCAG A/AA violations in the settings (${theme} theme)`, async ({ page }, testInfo) => {
			await page.addInitScript(
				(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
				theme
			);
			await open(page);
			await openSettings(page);
			expect(await audit(page)).toEqual([]);
			if (theme === 'dark') await captureScreen(page, testInfo, 'workout-settings');
		});
	}
});

test.describe("Train's rest timer", () => {
	const row = (page: Page) => page.getByTestId('open-rest-timer');
	const sheet = (page: Page) => page.getByTestId('rest-timer-sheet');
	const inline = (page: Page) => page.getByTestId('train-rest');

	let now = 0;

	/**
	 * Train, hydrated, with the time of day held: every reading is exact while the page's timers
	 * keep running, so its sheets still animate open and closed (a paused clock would hold a
	 * closing sheet open, and a navigation, until the test moved time on).
	 */
	async function openTrain(page: Page) {
		await page.clock.install();
		await page.goto('/train');
		await page.waitForLoadState('networkidle');
		now = await page.evaluate(() => Date.now() + 1_000);
		await page.clock.setFixedTime(now);
	}

	/** Moves the held time of day on by `ms`. */
	async function advance(page: Page, ms: number) {
		now += ms;
		await page.clock.setFixedTime(now);
	}

	test('starts, survives a reload and can be skipped, opening no workout', async ({ page }) => {
		// Every page the tab shows is recorded: the timer must never take it to a workout. Train
		// itself may link to one ('Log a session'), so it is the timer's own row, sheet and inline
		// reading that must hold no such link.
		const visited: string[] = [];
		page.on('framenavigated', (frame) => {
			if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname);
		});
		const workoutLinks = (scope: Locator) => scope.locator('a[href*="/workout"]');
		await openTrain(page);
		await expect(row(page)).toBeEnabled();
		await expect(row(page), 'the row opens a sheet, not a page').toHaveJSProperty(
			'tagName',
			'BUTTON'
		);
		await row(page).click();
		await expect(sheet(page)).toBeVisible();
		await expect(workoutLinks(sheet(page)), 'no link in the sheet opens a workout').toHaveCount(0);
		await expect(sheet(page).getByTestId('start-isolation-rest')).toHaveText('Isolation · 1:30');
		await sheet(page).getByTestId('start-isolation-rest').click();
		await expect(sheet(page).getByTestId('rest-time')).toHaveText('1:30');
		await advance(page, 20_000);
		await expect(sheet(page).getByTestId('rest-time')).toHaveText('1:10');
		expect(await stored(page, 'pc:rest:v1')).toMatchObject({ durationMs: 90_000, pausedAt: null });

		// Closed, it runs under its row.
		await page.keyboard.press('Escape');
		await expect(sheet(page)).toBeHidden();
		await expect(inline(page).getByTestId('rest-time')).toHaveText('1:10');
		await expect(workoutLinks(inline(page)), 'no link under the row opens a workout').toHaveCount(
			0
		);

		// After a reload it is back under its row untapped, still running, at the right time.
		await page.reload();
		await page.waitForLoadState('networkidle');
		await expect(inline(page).getByTestId('rest-time')).toHaveText('1:10');
		// And after a visit to another screen.
		const nav = page.getByRole('navigation', { name: 'Primary' });
		await nav.getByRole('link', { name: 'Today' }).click();
		await expect(page.getByRole('heading', { level: 1 })).toContainText('Today');
		await nav.getByRole('link', { name: 'Train' }).click();
		await expect(inline(page).getByTestId('rest-time')).toHaveText('1:10');
		await row(page).click();
		await expect(sheet(page).getByTestId('rest-time')).toHaveText('1:10');
		await advance(page, 10_000);
		await expect(sheet(page).getByTestId('rest-time')).toHaveText('1:00');
		await page.keyboard.press('Escape');
		await expect(sheet(page)).toBeHidden();
		await expect(inline(page).getByTestId('rest-time')).toHaveText('1:00');
		expect(new URL(page.url()).pathname).toBe('/train');

		await inline(page).getByRole('button', { name: 'Skip' }).click();
		await expect(inline(page)).toHaveCount(0);
		await expect(row(page)).toBeFocused();
		expect(await stored(page, 'pc:rest:v1')).toBeNull();
		await page.reload();
		await page.waitForLoadState('networkidle');
		await row(page).click();
		await expect(sheet(page).getByTestId('start-main-rest')).toBeVisible();
		await expect(sheet(page).getByTestId('rest-timer')).toHaveCount(0);
		expect(new URL(page.url()).pathname).toBe('/train');
		expect(visited, 'every page the tab showed').toEqual(
			expect.arrayContaining(['/train', '/today'])
		);
		expect(
			visited.filter((path) => path.startsWith('/workout')),
			'no workout opened'
		).toEqual([]);
	});

	test('its lengths are the workout settings’', async ({ page }) => {
		await page.addInitScript(() =>
			localStorage.setItem('pc:workout:v1', JSON.stringify({ rest: { timed: 45 } }))
		);
		await openTrain(page);
		await row(page).click();
		await expect(sheet(page).getByTestId('start-timed-rest')).toHaveText('Timed · 0:45');
		await expect(sheet(page).getByTestId('start-main-rest')).toHaveText('Main lifts · 3:00');
	});

	for (const theme of THEMES) {
		test(`no WCAG A/AA violations, idle and running (${theme} theme)`, async ({
			page
		}, testInfo) => {
			await page.addInitScript(
				(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
				theme
			);
			await page.goto('/train');
			await page.waitForLoadState('networkidle');
			await row(page).click();
			await expect(sheet(page)).toBeVisible();
			expect(await audit(page), 'idle').toEqual([]);
			await sheet(page).getByTestId('start-compound-rest').click();
			await expect(sheet(page).getByTestId('rest-timer')).toBeVisible();
			expect(await audit(page), 'running').toEqual([]);
			if (theme === 'dark') await captureScreen(page, testInfo, 'train-rest-timer');
			await page.keyboard.press('Escape');
			await expect(inline(page)).toBeVisible();
			expect(await audit(page), 'under its row').toEqual([]);
		});
	}
});
