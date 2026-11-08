/**
 * The rest timer and the stopwatch on /workout (PRD §8): a completed set starts the rest the flow
 * names, a timestamp stored with the workout, so a reload or a closed tab shows exactly the right
 * time; its controls and the stopwatch's are device actions, never sent. From the shared kit
 * fixture seeded in IndexedDB; sync is held ('hold'), so nothing here writes Postgres.
 *
 * Time is Playwright's clock: once the store is open it is paused, and each step moves it on by
 * hand, so every reading is exact. A paused clock stays paused across a reload, and so do the
 * page's idle callbacks: `connect` lets the store open by running two seconds of them.
 * The desktop dock, its hover and focus states are workout-rest.desktop.e2e.ts.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { StrengthKit } from '../src/lib/domain/workout';
import { captureScreen } from './support';
import {
	forceSafeArea,
	gotoWorkout,
	readOutbox,
	readWorkout,
	seedWorkout,
	workoutDay
} from './workout-support';

let kit: StrengthKit;
test.beforeAll(async () => {
	kit = (await workoutDay()).strength;
});

const card = (page: Page) => page.getByTestId('workout-main').getByTestId('exercise');
const heading = (page: Page) => card(page).getByRole('heading', { level: 2 });
const logger = (page: Page) => page.getByTestId('set-logger');
const next = (page: Page) => page.getByTestId('exercise-next');
const pill = (page: Page) => page.getByTestId('rest-timer');
const time = (page: Page) => pill(page).getByTestId('rest-time');
const control = (page: Page, name: string) => pill(page).getByRole('button', { name });
const stopwatch = (page: Page) => page.getByTestId('stopwatch');
const stopwatchText = async (page: Page) => (await stopwatch(page).textContent())!.trim();

/** Seeds the workout, opens /workout with the clock installed, and goes to exercise `name`. */
async function open(page: Page, name = 'Back squat', { pause = true } = {}): Promise<string> {
	await page.clock.install();
	const workoutId = await seedWorkout(page, kit);
	await gotoWorkout(page);
	await expect(page.locator('main#main[data-store]')).toBeAttached();
	await expect(logger(page)).toBeVisible();
	// Time stands still from here: each step moves it on by hand.
	if (pause) await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
	while ((await heading(page).textContent())?.trim() !== name) await next(page).click();
	await expect(heading(page)).toHaveText(name);
	return workoutId;
}

/** A reload, back to a restored page (its store not open while the clock is paused). */
async function reload(page: Page) {
	await page.reload();
	await expect(page.locator('main#main[data-ready]')).toBeAttached();
}

/** Runs two seconds of the paused clock, for the idle work that opens the store. */
async function connect(page: Page) {
	await page.clock.runFor(2_000);
	await expect(page.locator('main#main[data-store]')).toBeAttached();
}

/** Completes the leg press's set at hand at 120 kg. */
async function logLegPress(page: Page) {
	const load = logger(page).getByTestId('logger-load').getByRole('spinbutton');
	if ((await load.inputValue()) !== '120') {
		await load.click();
		await load.fill('120');
		await load.press('Enter');
	}
	await logger(page).getByTestId('complete-set').click();
}

const outboxTypes = async (page: Page) =>
	(await readOutbox(page)).map((entry) => entry.envelope.type);

async function audit(page: Page): Promise<string[]> {
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) =>
		v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
	);
}

test.describe('the rest timer (IndexedDB only)', () => {
	// gotoWorkout holds /api/workouts/* with page.route, which WebKit applies only without a worker.
	test.use({ serviceWorkers: 'block' });

	test('a leg press set starts its 2:00; it counts down, survives a reload, pauses, adds 30 s, resets and skips', async ({
		page
	}) => {
		const workoutId = await open(page, 'Leg press');
		await expect(pill(page)).toHaveCount(0);
		await logLegPress(page);
		await expect(pill(page)).toHaveAttribute('data-phase', 'running');
		await expect(time(page)).toHaveText('2:00');

		await page.clock.fastForward(40_000);
		await expect(time(page)).toHaveText('1:20');
		await reload(page);
		await expect(time(page)).toHaveText('1:20');
		await expect(pill(page)).toHaveAttribute('data-phase', 'running');

		await connect(page);
		await expect(time(page)).toHaveText('1:18');
		await control(page, 'Pause rest').click();
		await expect(pill(page)).toHaveAttribute('data-phase', 'paused');
		await page.clock.fastForward(60_000);
		await expect(time(page)).toHaveText('1:18');
		await reload(page);
		await expect(pill(page)).toHaveAttribute('data-phase', 'paused');
		await expect(time(page)).toHaveText('1:18');

		await connect(page);
		await control(page, 'Resume rest').click();
		await expect(pill(page)).toHaveAttribute('data-phase', 'running');
		await control(page, '+30 s').click();
		await expect(time(page)).toHaveText('1:48');
		await control(page, 'Reset rest').click();
		await expect(time(page)).toHaveText('2:00');
		await control(page, 'Skip').click();
		await expect(pill(page)).toHaveCount(0);
		await expect
			.poll(async () => (await readWorkout(page, workoutId)) as { device: { rest: unknown } })
			.toMatchObject({ device: { rest: null } });
		await reload(page);
		await expect(pill(page)).toHaveCount(0);
		// Every one of them is device state: only the workout and its set are sent.
		expect(await outboxTypes(page)).toEqual(['workout.start', 'set.log']);
	});

	test('at zero it vibrates where the browser can, and after a closed tab it says how long ago it ended', async ({
		page,
		browserName
	}) => {
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		// Records each vibration where the Vibration API exists (Chromium; never WebKit).
		await page.addInitScript(() => {
			const calls: unknown[] = [];
			Object.assign(window, { vibrations: calls });
			if (!('vibrate' in Navigator.prototype)) return;
			Object.defineProperty(Navigator.prototype, 'vibrate', {
				configurable: true,
				value: (pattern: unknown) => calls.push(pattern) > 0
			});
		});
		const vibrations = () => page.evaluate(() => (window as { vibrations?: unknown[] }).vibrations);

		await open(page, 'Leg press');
		await logLegPress(page);
		await expect(time(page)).toHaveText('2:00');
		await page.clock.fastForward(120_000 + 42_000);
		await expect(pill(page)).toHaveAttribute('data-phase', 'over');
		await expect(time(page)).toHaveText('Rest over · 0:42 ago');
		if (browserName === 'chromium') {
			await expect.poll(vibrations).toEqual([[200, 100, 200]]);
		} else {
			expect(await vibrations()).toEqual([]);
		}

		// A closed tab: on reopening, the rest that ended meanwhile reads over, and buzzes no more.
		await reload(page);
		await expect(pill(page)).toHaveAttribute('data-phase', 'over');
		await expect(time(page)).toHaveText('Rest over · 0:42 ago');
		await page.clock.fastForward(5_000);
		await expect(time(page)).toHaveText('Rest over · 0:47 ago');
		expect(await vibrations()).toEqual([]);

		await connect(page);
		await control(page, 'Dismiss').click();
		await expect(pill(page)).toHaveCount(0);
		expect(errors).toEqual([]);
	});

	test('Start rest starts one by hand: with auto-start off, and again after Skip', async ({
		page
	}) => {
		await page.addInitScript(() =>
			localStorage.setItem('pc:workout:v1', JSON.stringify({ autoStartRest: false }))
		);
		await open(page, 'Leg press');
		const start = page.getByTestId('start-rest');
		await logLegPress(page);
		await expect(pill(page)).toHaveCount(0);
		await start.click();
		await expect(time(page)).toHaveText('2:00');
		await expect(start).toHaveCount(0);
		await control(page, 'Skip').click();
		await expect(pill(page)).toHaveCount(0);
		await start.click();
		await expect(pill(page)).toHaveAttribute('data-phase', 'running');
		await expect(time(page)).toHaveText('2:00');
	});

	test('in the superset: no rest after A1 set 1, the round’s 1:30 after A2 set 1', async ({
		page
	}) => {
		await open(page, 'Pull-up');
		await logger(page).getByTestId('complete-set').click();
		await expect(heading(page)).toHaveText('Plank');
		await expect(pill(page)).toHaveCount(0);
		await logger(page).getByTestId('complete-set').click();
		await expect(heading(page)).toHaveText('Pull-up');
		await expect(time(page)).toHaveText('1:30');
	});

	test('the pill stays in view on another exercise, above the logger and the home indicator', async ({
		page
	}) => {
		await open(page, 'Leg press');
		await forceSafeArea(page, { bottom: 34 });
		await logLegPress(page);
		await expect(time(page)).toHaveText('2:00');

		await next(page).click();
		await expect(heading(page)).toHaveText('Romanian deadlift');
		await expect(pill(page)).toBeInViewport();
		await expect(time(page)).toHaveText('2:00');
		const viewport = page.viewportSize()!;
		for (const scroll of [0, 10_000]) {
			await page.evaluate((y) => scrollTo(0, y), scroll);
			const rest = (await pill(page).boundingBox())!;
			const log = (await logger(page).boundingBox())!;
			expect(
				rest.y + rest.height,
				`the pill ends above the logger (scrolled ${scroll})`
			).toBeLessThanOrEqual(log.y + 1);
			expect(log.y + log.height).toBeGreaterThanOrEqual(viewport.height - 1);
			expect(rest.y).toBeGreaterThanOrEqual(0);
		}

		// With every set logged there is no logger: the pill keeps clear of the home indicator.
		await page.getByTestId('exercise-prev').click();
		await expect(heading(page)).toHaveText('Leg press');
		await logLegPress(page);
		await logLegPress(page);
		await expect(page.getByTestId('exercise-done')).toBeVisible();
		await page.evaluate(() => scrollTo(0, 0));
		await expect(pill(page)).toBeInViewport();
		const rest = (await pill(page).boundingBox())!;
		expect(rest.y + rest.height).toBeLessThanOrEqual(viewport.height - 34);
	});

	test('the stopwatch pauses and resumes, each surviving a reload', async ({ page }) => {
		await open(page);
		await expect(stopwatch(page)).not.toHaveAttribute('data-paused');
		await page.getByRole('button', { name: 'Pause workout time' }).click();
		await expect(stopwatch(page)).toHaveAttribute('data-paused', '');
		const paused = await stopwatchText(page);
		await page.clock.fastForward(60_000);
		await expect(stopwatch(page)).toHaveText(paused);
		await reload(page);
		await expect(stopwatch(page)).toHaveAttribute('data-paused', '');
		await expect(stopwatch(page)).toHaveText(paused);

		await connect(page);
		await page.getByRole('button', { name: 'Resume workout time' }).click();
		await expect(stopwatch(page)).not.toHaveAttribute('data-paused');
		await page.clock.fastForward(5_000);
		await expect(stopwatch(page)).not.toHaveText(paused);
		await reload(page);
		await expect(stopwatch(page)).not.toHaveAttribute('data-paused');
		const running = await stopwatchText(page);
		await page.clock.fastForward(3_000);
		await expect(stopwatch(page)).not.toHaveText(running);

		await connect(page);
		await page.getByRole('button', { name: 'Pause workout time' }).click();
		await page.getByRole('button', { name: 'Reset workout time' }).click();
		await expect(stopwatch(page)).toHaveText('0:00');
		expect(await outboxTypes(page)).toEqual(['workout.start']);
	});

	for (const theme of ['dark', 'light'] as const) {
		test(`no WCAG A/AA violations while resting, paused and over (${theme} theme)`, async ({
			page
		}, testInfo) => {
			await page.addInitScript(
				(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
				theme
			);
			// The clock runs here: axe has timers of its own.
			await open(page, 'Leg press', { pause: false });
			await logLegPress(page);
			await expect(pill(page)).toHaveAttribute('data-phase', 'running');
			expect(await audit(page), 'resting').toEqual([]);
			if (theme === 'dark') await captureScreen(page, testInfo, 'workout-rest');

			await control(page, 'Pause rest').click();
			await expect(pill(page)).toHaveAttribute('data-phase', 'paused');
			expect(await audit(page), 'paused').toEqual([]);
			if (theme === 'dark') await captureScreen(page, testInfo, 'workout-rest-paused');

			await control(page, 'Resume rest').click();
			await page.clock.fastForward(3 * 60_000);
			await expect(pill(page)).toHaveAttribute('data-phase', 'over');
			expect(await audit(page), 'over').toEqual([]);
			if (theme === 'dark') await captureScreen(page, testInfo, 'workout-rest-over');
		});
	}
});
