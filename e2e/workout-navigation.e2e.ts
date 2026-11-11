/**
 * Moving between exercises on /workout (PRD §7): swipe the card or use Previous and Next, with Up
 * next always in view and announced once a set moves the workout on. From the shared kit fixture
 * seeded in IndexedDB; sync is held ('hold'), so nothing here writes Postgres: the current
 * exercise is device state, never sent, so the outbox keeps only the workout's start and its sets.
 * The side list and the keyboard are workout-navigation.desktop.e2e.ts.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { StrengthKit } from '../src/lib/domain/workout';
import { DB_NAME, STORES } from '../src/lib/client/workout/names';
import { expectNoSideScroll } from './desktop';
import { captureScreen } from './support';
import {
	gotoWorkout,
	readOutbox,
	readWorkout,
	seedWorkout,
	watchMove,
	workoutDay,
	type WatchedMove
} from './workout-support';

let kit: StrengthKit;
test.beforeAll(async () => {
	kit = (await workoutDay()).strength;
});

const [BACK_SQUAT, LEG_PRESS, , PULL_UP] = [1, 2, 3, 4];

async function setPosition(page: Page, workoutId: string, position: number) {
	await page.evaluate(
		async ({ name, store, workoutId, position }) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(name);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			const objects = db.transaction(store, 'readwrite').objectStore(store);
			const read = objects.get(workoutId);
			await new Promise((resolve) => (read.onsuccess = resolve));
			const record = read.result as { device: { position: number } };
			record.device.position = position;
			objects.put(record);
			await new Promise((resolve) => (objects.transaction.oncomplete = resolve));
			db.close();
		},
		{ name: DB_NAME, store: STORES.workouts, workoutId, position }
	);
}

/** Seeds the workout at `position`, opens /workout and waits until it can move and log. */
async function open(page: Page, position = BACK_SQUAT): Promise<string> {
	const workoutId = await seedWorkout(page, kit);
	if (position !== BACK_SQUAT) await setPosition(page, workoutId, position);
	await gotoWorkout(page);
	await expect(page.locator('main#main[data-store]')).toBeAttached();
	await expect(upNext(page)).toBeVisible();
	await expect(logger(page).or(page.getByTestId('exercise-done'))).toBeVisible();
	return workoutId;
}

const card = (page: Page) => page.getByTestId('workout-main').getByTestId('exercise');
const heading = (page: Page) => card(page).getByRole('heading', { level: 2 });
const upNext = (page: Page) => page.getByTestId('up-next');
const said = (page: Page) => page.getByTestId('up-next-said');
const logger = (page: Page) => page.getByTestId('set-logger');
const prev = (page: Page) => page.getByTestId('exercise-prev');
const next = (page: Page) => page.getByTestId('exercise-next');

/** The outbox's mutation types: a move between exercises is never one. */
const outboxTypes = async (page: Page) =>
	(await readOutbox(page)).map((entry) => entry.envelope.type);

/**
 * A mouse drag across the card (dy down), in steps, as a hand would. It starts on the card's
 * name: on a phone the logger, stuck to the foot of the screen, covers the rest of it. `holdMs`
 * waits after the press, for a slow drag: WebKit runs the steps in a few ms, and a quick short
 * drag is a flick (swipe.ts).
 */
async function drag(page: Page, dx: number, dy = 0, holdMs = 0) {
	const box = (await heading(page).boundingBox())!;
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	if (holdMs) await page.waitForTimeout(holdMs);
	await page.mouse.move(x + dx, y + dy, { steps: 8 });
	await page.mouse.up();
}

async function noSideScroll(page: Page) {
	await expectNoSideScroll(page);
	expect(await page.evaluate(() => scrollX)).toBe(0);
}

async function audit(page: Page): Promise<string[]> {
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) =>
		v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
	);
}

/** Logs the leg press's three sets at 120 kg: the first asks for the weight, the rest keep it. */
async function finishLegPress(page: Page) {
	const load = logger(page).getByTestId('logger-load').getByRole('spinbutton');
	await load.click();
	await load.fill('120');
	await load.press('Enter');
	for (let set = 1; set <= 3; set += 1) {
		await expect(logger(page)).toContainText(`Set ${set} of 3`);
		await logger(page).getByTestId('complete-set').click();
	}
	await expect(page.getByTestId('exercise-done')).toHaveText('All sets logged');
}

test.describe('moving between exercises (IndexedDB only)', () => {
	// gotoWorkout holds /api/workouts/* with page.route, which WebKit applies only without a worker.
	test.use({ serviceWorkers: 'block' });

	test('Next and Previous move in workout order, each disabled at its end', async ({ page }) => {
		await open(page);
		await expect(heading(page)).toHaveText('Back squat');
		await expect(prev(page)).toBeDisabled();
		await next(page).click();
		await expect(heading(page)).toHaveText('Leg press');
		await expect(card(page)).toContainText('Exercise 2 of 5');
		await prev(page).click();
		await expect(heading(page)).toHaveText('Back squat');
		for (const name of ['Leg press', 'Romanian deadlift', 'Pull-up', 'Plank']) {
			await next(page).click();
			await expect(heading(page)).toHaveText(name);
		}
		await expect(next(page)).toBeDisabled();
		await expect(prev(page)).toBeEnabled();
		expect(await outboxTypes(page)).toEqual(['workout.start']);
	});

	test('a mouse drag left goes to the next exercise and right to the previous; a vertical or short drag stays, and nothing scrolls sideways', async ({
		page
	}) => {
		await open(page);
		await drag(page, -200);
		await expect(heading(page)).toHaveText('Leg press');
		await noSideScroll(page);
		await drag(page, 200);
		await expect(heading(page)).toHaveText('Back squat');
		// At the first exercise a drag right has nowhere to go.
		await drag(page, 200);
		await expect(heading(page)).toHaveText('Back squat');

		await drag(page, 30, 260);
		await drag(page, 0, -260);
		// 40 px over 200 ms: under SWIPE_MIN_DISTANCE, and too slow for a flick.
		await drag(page, -40, 0, 200);
		await expect(heading(page)).toHaveText('Back squat');
		await noSideScroll(page);
		expect(await outboxTypes(page)).toEqual(['workout.start']);
	});

	test('the card follows the mouse 1:1, resists past the first exercise, and springs back when let go short', async ({
		page
	}) => {
		await open(page);
		const offset = () =>
			card(page).evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41);
		const box = (await heading(page).boundingBox())!;
		const x = box.x + box.width / 2;
		const y = box.y + box.height / 2;
		await page.mouse.move(x, y);
		await page.mouse.down();
		// Toward Leg press: the card is the pointer, with nothing easing it.
		await page.mouse.move(x - 120, y, { steps: 6 });
		expect(await offset()).toBeCloseTo(-120, 0);
		// Toward nothing (Back squat is first): it gives way, but well short of the pointer.
		await page.mouse.move(x + 120, y, { steps: 6 });
		const resisted = await offset();
		expect(resisted).toBeGreaterThan(0);
		expect(resisted).toBeLessThan(80);
		await noSideScroll(page);
		await page.mouse.up();
		await expect(heading(page)).toHaveText('Back squat');
		await expect.poll(offset).toBe(0);
		expect(await card(page).evaluate((el) => el.style.transform)).toBe('');
		await expect(page.locator('.swipe[data-moving]')).toHaveCount(0);
	});

	test('with reduced motion the card still follows the mouse, then lands at once', async ({
		page
	}) => {
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await open(page);
		const box = (await heading(page).boundingBox())!;
		// From the name's right end, so the 200 px drag stays on the screen, as a finger does.
		// WebKit gives a mouse event whole-pixel coordinates, cut toward 0: from the name's middle
		// the pointer ended off the left edge, at -72.3 read as -72, and the card was 1 px short.
		const x = box.x + box.width - 8;
		const y = box.y + box.height / 2;
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.mouse.move(x - 200, y, { steps: 8 });
		expect(
			await card(page).evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41)
		).toBeCloseTo(-200, 0);
		await page.mouse.up();
		await expect(heading(page)).toHaveText('Leg press');
		expect(
			await card(page).evaluate((el) => ({
				animations: el.getAnimations().length,
				transform: getComputedStyle(el).transform
			}))
		).toEqual({ animations: 0, transform: 'none' });
	});

	test('Next to a taller or shorter card: Previous and Next never jump, they slide to their place', async ({
		page
	}) => {
		await open(page);
		const moves: WatchedMove[] = [];
		for (let step = 0; step < kit.exercises.length - 1; step++) {
			const move = await watchMove(page, 'exercise-next');
			// The first frame shows them where they were.
			expect(
				Math.abs(move.first - move.before),
				`step ${step + 1}: ${JSON.stringify(move)}`
			).toBeLessThanOrEqual(1);
			moves.push(move);
		}
		const moved = moves.filter((move) => Math.abs(move.after - move.before) > 1);
		expect(moved.length, 'the fixture has cards of different heights').toBeGreaterThan(0);
		for (const move of moved) expect(move.sliding, JSON.stringify(move)).toBe(1);
	});

	test('with reduced motion, Previous and Next land in their new place at once', async ({
		page
	}) => {
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await open(page);
		let moved = 0;
		for (let step = 0; step < kit.exercises.length - 1; step++) {
			const move = await watchMove(page, 'exercise-next');
			expect(move.sliding).toBe(0);
			expect(Math.abs(move.first - move.after), JSON.stringify(move)).toBeLessThanOrEqual(1);
			if (Math.abs(move.after - move.before) > 1) moved += 1;
		}
		expect(moved, 'the fixture has cards of different heights').toBeGreaterThan(0);
	});

	test('a swipe that ends on a logged set’s row moves on without opening its editor', async ({
		page
	}) => {
		// A round of the superset: both first sets logged, back on the pull-up. Each card's first
		// row is a logged set's button, so a click the swipe let through would open the plank's.
		await open(page, PULL_UP);
		await logger(page).getByTestId('complete-set').click();
		await expect(heading(page)).toHaveText('Plank');
		await logger(page).getByTestId('complete-set').click();
		await expect(heading(page)).toHaveText('Pull-up');
		const row = card(page).getByTestId('set').first().getByRole('button');
		// Above the logger, which covers the foot of the screen.
		await row.evaluate((el) => el.scrollIntoView({ block: 'start' }));
		const box = (await row.boundingBox())!;
		const y = box.y + box.height / 2;
		await page.mouse.move(box.x + box.width - 8, y);
		await page.mouse.down();
		await page.mouse.move(box.x + 8, y, { steps: 8 });
		await page.mouse.up();
		await expect(heading(page)).toHaveText('Plank');
		await expect(page.getByTestId('set-editor')).toHaveCount(0);
	});

	test('the current exercise survives a reload', async ({ page }) => {
		const workoutId = await open(page);
		await next(page).click();
		await next(page).click();
		await expect(heading(page)).toHaveText('Romanian deadlift');
		await expect
			.poll(
				async () =>
					((await readWorkout(page, workoutId)) as { device: { position: number } }).device.position
			)
			.toBe(3);
		await page.reload();
		await expect(page.locator('main#main[data-ready]')).toBeAttached();
		await expect(heading(page)).toHaveText('Romanian deadlift');
		await expect(card(page)).toContainText('Exercise 3 of 5');
	});

	test('the leg press done: Romanian deadlift is announced, the between-exercises state offers it, and Start readies its first set', async ({
		page
	}, testInfo) => {
		await open(page, LEG_PRESS);
		await expect(upNext(page)).toContainText('Romanian deadlift');
		await expect(upNext(page)).toContainText('3 × 8 at RPE 7');
		await expect(upNext(page)).not.toHaveAttribute('data-between');

		await finishLegPress(page);
		await expect(said(page)).toHaveText('Next: Romanian deadlift, 3 × 8 at RPE 7');
		await expect(said(page)).toHaveAttribute('role', 'status');
		await expect(upNext(page)).toHaveAttribute('data-between', '');
		const start = upNext(page).getByRole('button', { name: 'Start Romanian deadlift' });
		await expect(start).toBeVisible();
		// Still the leg press until Start: what was done stays in view.
		await expect(heading(page)).toHaveText('Leg press');
		await noSideScroll(page);
		await captureScreen(page, testInfo, 'workout-between-exercises');

		await start.click();
		await expect(heading(page)).toHaveText('Romanian deadlift');
		await expect(logger(page)).toContainText('Set 1 of 3 · 8 reps · RPE 7');
		await expect(upNext(page)).not.toHaveAttribute('data-between');
		expect(await outboxTypes(page)).toEqual(['workout.start', 'set.log', 'set.log', 'set.log']);
	});

	test('nothing is said mid-exercise; inside the superset a set of A1 announces A2', async ({
		page
	}) => {
		await open(page, PULL_UP);
		await expect(upNext(page)).toContainText(/A2\s*Plank/);
		await expect(upNext(page)).toContainText('45 s');
		await logger(page).getByTestId('complete-set').click();
		await expect(heading(page)).toHaveText('Plank');
		await expect(said(page)).toHaveText('Next: A2 Plank, 45 s at RPE 7');
		// From A2, Up next is A1 again.
		await expect(upNext(page)).toContainText(/A1\s*Pull-up/);
		await expect(upNext(page)).toContainText('6–10 reps at RPE 8');

		await page.reload();
		await expect(upNext(page)).toBeVisible();
		await expect(said(page)).toHaveText('');
		await prev(page).click();
		await expect(heading(page)).toHaveText('Pull-up');
		await expect(said(page)).toHaveText('');
	});

	test('a finger swipe changes the exercise, and a vertical one scrolls the page instead', async ({
		page,
		browserName
	}) => {
		// Touch input is dispatched through Chromium's DevTools protocol.
		test.skip(browserName !== 'chromium', 'touch dispatch is Chromium-only');
		await open(page);
		const cdp = await page.context().newCDPSession(page);
		const touch = async (from: [number, number], to: [number, number]) => {
			const point = (x: number, y: number) => [{ x, y }];
			await cdp.send('Input.dispatchTouchEvent', {
				type: 'touchStart',
				touchPoints: point(...from)
			});
			for (let i = 1; i <= 10; i += 1) {
				const x = from[0] + ((to[0] - from[0]) * i) / 10;
				const y = from[1] + ((to[1] - from[1]) * i) / 10;
				await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(x, y) });
			}
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		};
		// From the card's name: the logger covers the foot of the screen.
		const box = (await heading(page).boundingBox())!;
		const x = box.x + box.width / 2;
		const y = box.y + box.height / 2;

		await touch([x + 100, y], [x - 100, y]);
		await expect(heading(page)).toHaveText('Leg press');
		await noSideScroll(page);

		const before = await page.evaluate(() => scrollY);
		await touch([x, y], [x, y - 120]);
		await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(before);
		await expect(heading(page)).toHaveText('Leg press');
		await noSideScroll(page);
	});

	for (const theme of ['dark', 'light'] as const) {
		test(`no WCAG A/AA violations moving between exercises (${theme} theme)`, async ({ page }) => {
			await page.addInitScript(
				(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
				theme
			);
			await open(page, LEG_PRESS);
			expect(await audit(page), 'Up next').toEqual([]);
			await finishLegPress(page);
			await expect(upNext(page)).toHaveAttribute('data-between', '');
			expect(await audit(page), 'between exercises').toEqual([]);
		});
	}
});
