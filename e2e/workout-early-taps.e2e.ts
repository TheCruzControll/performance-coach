/**
 * The workout store opens right after the first paint on every engine (WebKit has no idle
 * callback, so it used to wait a fixed 500 ms), and a tap that comes before it is kept: the rest
 * timer's and the stopwatch's controls with the time of the tap, Complete set once per set. The
 * logger shows as soon as its chunk has loaded, its space reserved from the view's first render.
 * performance marks pc:store-open and pc:logger-ready time both; each test reports them.
 *
 * From the shared kit fixture seeded in IndexedDB; sync is held ('hold'), so nothing here writes
 * Postgres. Where time matters it is Playwright's clock, paused, which holds the page's frames
 * and timers too: after a reload the store stays shut until the test runs the clock.
 */
import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import type { StrengthKit } from '../src/lib/domain/workout';
import { gotoWorkout, readOutbox, seedWorkout, workoutDay } from './workout-support';

// gotoWorkout and the held chunks use page.route, which WebKit applies only without a worker.
test.use({ serviceWorkers: 'block' });

let kit: StrengthKit;
test.beforeAll(async () => {
	kit = (await workoutDay()).strength;
});

const opened = (page: Page) => page.locator('main#main[data-store]');
const card = (page: Page) => page.getByTestId('workout-main').getByTestId('exercise');
const heading = (page: Page) => card(page).getByRole('heading', { level: 2 });
const rows = (page: Page) => page.getByTestId('workout-main').getByTestId('set');
const logger = (page: Page) => page.getByTestId('set-logger');
const pill = (page: Page) => page.getByTestId('rest-timer');
const time = (page: Page) => pill(page).getByTestId('rest-time');
const stopwatch = (page: Page) => page.getByTestId('stopwatch');
const outboxTypes = async (page: Page) =>
	(await readOutbox(page)).map((entry) => entry.envelope.type);

/** Goes on to exercise `name` with Next. */
async function goTo(page: Page, name: string) {
	while ((await heading(page).textContent())?.trim() !== name)
		await page.getByTestId('exercise-next').click();
	await expect(heading(page)).toHaveText(name);
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

/**
 * Holds every JS chunk whose code matches `marker` until `release()`; the others pass. The store's
 * chunk (online.ts) is the one that exports goOnline; the logger's records pc:set-confirmed.
 */
async function holdChunk(page: Page, marker: RegExp) {
	let release = () => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	let seen = false;
	await page.route('**/_app/immutable/**/*.js', async (route: Route) => {
		const response = await route.fetch();
		const body = await response.text();
		if (marker.test(body)) {
			seen = true;
			await held;
		}
		await route.fulfill({ response, body });
	});
	return { release, seen: () => seen };
}
const STORE_CHUNK = /as goOnline[,}]/;
const LOGGER_CHUNK = /pc:set-confirmed/;

/** Within a pixel: layout rounds differently from one paint to the next. */
const expectNear = (actual: number, expected: number, what: string) =>
	expect(Math.abs(actual - expected), `${what}: ${actual} vs ${expected}`).toBeLessThanOrEqual(1);

/** When the store opened and the logger was ready, in ms from navigation start, reported. */
async function reportMarks(page: Page, testInfo: TestInfo) {
	const marks = await page.evaluate(() =>
		Object.fromEntries(
			['pc:store-open', 'pc:logger-ready'].map((name) => [
				name,
				performance.getEntriesByName(name, 'mark').map((mark) => Math.round(mark.startTime))
			])
		)
	);
	for (const [name, times] of Object.entries(marks))
		testInfo.annotations.push({ type: name, description: `${times.join(', ')} ms` });
	return marks;
}

test('Complete set tapped before the store opens logs that set once, as the store opens', async ({
	page
}, testInfo) => {
	const store = await holdChunk(page, STORE_CHUNK);
	await seedWorkout(page, kit);
	await gotoWorkout(page);
	// The logger shows from its own chunk, the store still shut.
	await expect(logger(page)).toBeVisible();
	await expect.poll(store.seen).toBe(true);
	await expect(opened(page)).toHaveCount(0);
	await expect(rows(page).first()).toHaveAttribute('data-state', 'current');

	const complete = logger(page).getByTestId('complete-set');
	await complete.click();
	await complete.click(); // the same set on screen: still one set
	await expect(rows(page).first()).toHaveAttribute('data-state', 'current');
	store.release();

	await expect(opened(page)).toBeAttached();
	await expect(rows(page).first()).toHaveAttribute('data-state', 'done');
	await expect(rows(page).nth(1)).toHaveAttribute('data-state', 'current');
	await expect.poll(() => outboxTypes(page)).toEqual(['workout.start', 'set.log']);

	const marks = await reportMarks(page, testInfo);
	expect(marks['pc:logger-ready']).toHaveLength(1);
	expect(marks['pc:store-open']).toHaveLength(1);
	expect(marks['pc:logger-ready']![0]!).toBeLessThan(marks['pc:store-open']![0]!);
});

test.describe('with the clock paused', () => {
	/** Seeds the workout and opens /workout at `name`, then stops time there. */
	async function open(page: Page, name = 'Back squat') {
		await page.clock.install();
		await seedWorkout(page, kit);
		await gotoWorkout(page);
		await expect(opened(page)).toBeAttached();
		await expect(logger(page)).toBeVisible();
		await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
		await goTo(page, name);
	}

	/** A reload, back to a restored page whose store stays shut while the clock is paused. */
	async function reload(page: Page) {
		await page.reload();
		await expect(page.locator('main#main[data-ready]')).toBeAttached();
		await expect(opened(page)).toHaveCount(0);
	}

	test('the store opens within a few frames of the restored page painting, on every engine', async ({
		page
	}) => {
		await open(page);
		await reload(page);
		// Six frames: two for the paint, the rest to spare. Never the old 500 ms timer (WebKit).
		await page.clock.runFor(100);
		await expect(opened(page)).toBeAttached();
	});

	test('rest and stopwatch taps before the store opens are kept, at the time of the tap', async ({
		page
	}) => {
		await open(page, 'Leg press');
		await logLegPress(page);
		await expect(time(page)).toHaveText('2:00');
		await page.clock.fastForward(30_000);
		await reload(page);
		await expect(pill(page)).toHaveAttribute('data-phase', 'running');
		await expect(time(page)).toHaveText('1:30');

		await pill(page).getByRole('button', { name: 'Pause rest' }).click();
		await page.getByRole('button', { name: 'Pause workout time' }).click();
		const paused = (await stopwatch(page).textContent())!.trim();
		await expect(opened(page)).toHaveCount(0);

		// Two seconds pass before the store opens: both stopped when they were tapped.
		await page.clock.runFor(2_000);
		await expect(opened(page)).toBeAttached();
		await expect(pill(page)).toHaveAttribute('data-phase', 'paused');
		await expect(time(page)).toHaveText('1:30');
		await expect(stopwatch(page)).toHaveAttribute('data-paused', '');
		await expect(stopwatch(page)).toHaveText(paused);

		await page.reload();
		await expect(pill(page)).toHaveAttribute('data-phase', 'paused');
		await expect(time(page)).toHaveText('1:30');
		await expect(stopwatch(page)).toHaveAttribute('data-paused', '');
		// Device state only: nothing more is sent.
		expect(await outboxTypes(page)).toEqual(['workout.start', 'set.log']);
	});
});

test('the logger’s space is kept from the first render: neither it nor the rest pill moves as it arrives', async ({
	page
}) => {
	test.skip(
		(page.viewportSize()?.width ?? 0) >= 1024,
		'from 1024 px the logger sits under the rows, after everything'
	);
	await seedWorkout(page, kit);
	await gotoWorkout(page);
	await expect(opened(page)).toBeAttached();
	await goTo(page, 'Leg press');
	await logLegPress(page);
	await expect(time(page)).toHaveText(/^[12]:\d\d$/);
	const box = (await logger(page).boundingBox())!;
	const pillBox = (await pill(page).boundingBox())!;

	const chunk = await holdChunk(page, LOGGER_CHUNK);
	await page.reload();
	await expect(page.locator('main#main[data-ready]')).toBeAttached();
	await expect.poll(chunk.seen).toBe(true);
	const space = page.getByTestId('logger-space');
	await expect(space).toBeVisible();
	await expect(logger(page)).toHaveCount(0);
	const spaceBox = (await space.boundingBox())!;
	expectNear(spaceBox.y, box.y, 'the space starts where the logger did');
	expectNear(spaceBox.height, box.height, 'the space is the logger’s height');
	expectNear((await pill(page).boundingBox())!.y, pillBox.y, 'the pill sits above the space');

	chunk.release();
	await expect(logger(page)).toBeVisible();
	await expect(space).toHaveCount(0);
	expectNear((await logger(page).boundingBox())!.y, box.y, 'the logger takes the space');
	expectNear((await pill(page).boundingBox())!.y, pillBox.y, 'the pill has not moved');
});
