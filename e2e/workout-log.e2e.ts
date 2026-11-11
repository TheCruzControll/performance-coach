/**
 * Logging a set on /workout (PRD §7–§8): the set at hand prefilled, logged in one tap, done in
 * the same frame and saved on the device first. From the shared kit fixture seeded in IndexedDB;
 * sync is held ('hold'), so nothing here writes Postgres: the outbox is the assertion. The
 * desktop layout and the keyboard are workout-log.desktop.e2e.ts.
 */
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { Mutation, StrengthKit } from '../src/lib/domain/workout';
import { DB_NAME, STORES } from '../src/lib/client/workout/names';
import { expectNoSideScroll, expectStableBoxes } from './desktop';
import { captureScreen } from './support';
import {
	forceSafeArea,
	gotoWorkout,
	readOutbox,
	seedWorkout,
	workoutDay,
	type SyncMode
} from './workout-support';

let kit: StrengthKit;
test.beforeAll(async () => {
	kit = (await workoutDay()).strength;
});

/** The build under test's client output. */
const CLIENT = '../.svelte-kit/output/client';

const LEG_PRESS = 2;
const PULL_UP = 4;

/** Seeds the workout at `position`, opens /workout and waits for the store and the logger. */
async function open(page: Page, position = 1, sync: SyncMode = 'hold'): Promise<string> {
	const workoutId = await seedWorkout(page, kit);
	if (position !== 1) await setPosition(page, workoutId, position);
	await gotoWorkout(page, 'strength', { sync });
	await expect(page.locator('main#main[data-store]')).toBeAttached();
	await expect(logger(page)).toBeVisible();
	return workoutId;
}

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

const logger = (page: Page) => page.getByTestId('set-logger');
const heading = (page: Page) =>
	page.getByTestId('workout-main').getByTestId('exercise').getByRole('heading', { level: 2 });
const rows = (page: Page) => page.getByTestId('workout-main').getByTestId('set');
const loadField = (page: Page) => logger(page).getByTestId('logger-load').getByRole('spinbutton');
const amountField = (page: Page) =>
	logger(page).getByTestId('logger-amount').getByRole('spinbutton');
const rpe = (page: Page, label: string) =>
	logger(page).getByRole('radio', { name: label, exact: true });

/** Types a value into a stepper, as the owner does by tapping it. */
async function enter(page: Page, field: ReturnType<typeof loadField>, value: string) {
	await field.click();
	await field.fill(value);
	await field.press('Enter');
}

/**
 * Taps Complete set and reads, in the very next animation frame, the rows' states and the current
 * exercise: what the owner sees in the frame after the tap.
 */
async function completeInFrame(page: Page) {
	return page.evaluate(
		() =>
			new Promise<{ states: string[]; exercise: string }>((resolve) => {
				const read = () => ({
					states: [
						...document.querySelectorAll('[data-testid="workout-main"] [data-testid="set"]')
					].map((row) => row.getAttribute('data-state') ?? ''),
					exercise: document.querySelector('#exercise-name')?.textContent ?? ''
				});
				document.querySelector<HTMLButtonElement>('[data-testid="complete-set"]')!.click();
				requestAnimationFrame(() => resolve(read()));
			})
	);
}

const setLogs = async (page: Page) =>
	(await readOutbox(page))
		.map((entry) => entry.envelope)
		.filter((m): m is Extract<Mutation, { type: 'set.log' }> => m.type === 'set.log');

async function audit(page: Page): Promise<string[]> {
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) =>
		v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
	);
}

/** Makes every IndexedDB put fail as a full disk does, until `liftPut` lifts it. */
const failPuts = (page: Page) =>
	page.evaluate(() => {
		const put = IDBObjectStore.prototype.put;
		Object.assign(window, { __liftPut: () => (IDBObjectStore.prototype.put = put) });
		IDBObjectStore.prototype.put = function () {
			throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
		};
	});
const liftPut = (page: Page) =>
	page.evaluate(() => (window as unknown as { __liftPut: () => void }).__liftPut());

test.describe('logging a set (IndexedDB only)', () => {
	// gotoWorkout holds /api/workouts/* with page.route, which WebKit applies only without a worker.
	test.use({ serviceWorkers: 'block' });

	test('three leg-press sets: weight, reps and RPE, each done in the frame after the tap', async ({
		page
	}, testInfo) => {
		const workoutId = await open(page, LEG_PRESS);
		await expect(heading(page)).toHaveText('Leg press');
		// RPE-based with no history: no weight is invented; the instruction asks for one.
		await expect(logger(page)).toContainText('Set 1 of 3 · 10 reps · RPE 7');
		await expect(loadField(page)).toHaveAttribute('aria-valuenow', '0');
		await expect(logger(page).getByTestId('logger-load')).toContainText(
			'Pick a load that feels like RPE 7'
		);
		await expect(amountField(page)).toHaveAttribute('aria-valuenow', '10');
		await expect(rpe(page, '7')).toBeChecked();
		await captureScreen(page, testInfo, 'workout-logging');

		// A weighted set needs a weight: Complete set asks for it instead of logging 0.
		await logger(page).getByTestId('complete-set').click();
		await expect(logger(page).getByRole('alert')).toHaveText('Enter the weight you used');
		expect(await setLogs(page)).toEqual([]);

		await enter(page, loadField(page), '120');
		await rpe(page, '8').check();
		expect((await completeInFrame(page)).states).toEqual(['done', 'current', 'todo']);

		// The second set starts from the first: its weight, the plan's reps, the target RPE.
		await expect(logger(page)).toContainText('Set 2 of 3');
		await expect(loadField(page)).toHaveAttribute('aria-valuenow', '120');
		await expect(logger(page).getByTestId('logger-load')).toContainText('Same as your last set');
		await expect(amountField(page)).toHaveAttribute('aria-valuenow', '10');
		await expect(rpe(page, '7')).toBeChecked();
		await enter(page, amountField(page), '9');
		await rpe(page, '8.5').check();
		expect((await completeInFrame(page)).states).toEqual(['done', 'done', 'current']);

		await expect(loadField(page)).toHaveAttribute('aria-valuenow', '120');
		await rpe(page, 'No RPE').check();
		expect((await completeInFrame(page)).states).toEqual(['done', 'done', 'done']);
		await expect(page.getByTestId('exercise-done')).toHaveText('All sets logged');
		await expect(rows(page)).toHaveText([
			/120 kg × 10 reps · RPE 8\s*Done$/,
			/120 kg × 9 reps · RPE 8\.5\s*Done$/,
			/120 kg × 10 reps\s*Done$/
		]);

		const press = kit.exercises[LEG_PRESS - 1]!;
		await expect.poll(async () => (await setLogs(page)).length).toBe(3);
		const logs = await setLogs(page);
		expect(logs.map((m) => m.payload)).toEqual(
			[
				{ setIndex: 1, reps: 10, rpe: 8 },
				{ setIndex: 2, reps: 9, rpe: 8.5 },
				{ setIndex: 3, reps: 10, rpe: null }
			].map((set) => ({
				position: LEG_PRESS,
				plannedLineage: press.plannedLineage,
				exerciseId: press.exercise.id,
				seconds: null,
				metres: null,
				weight: 120,
				assistance: null,
				unit: 'kg',
				missedReps: 0,
				isWarmup: false,
				isExtra: false,
				...set
			}))
		);
		for (const m of logs) {
			expect(m).toMatchObject({ v: 1, workoutId, entityId: m.id });
			expect(m.id).toMatch(/^[0-9a-f-]{36}$/);
		}
		expect(new Set(logs.map((m) => m.id)).size).toBe(3);
		const measures = await page.evaluate(() =>
			performance.getEntriesByName('pc:set-confirmed').map((entry) => entry.duration)
		);
		expect(measures).toHaveLength(3);
		for (const duration of measures) expect(duration).toBeGreaterThan(0);
	});

	test('the superset: A1 pull-up set 1 makes A2 plank current, A2 set 1 makes A1 set 2 current', async ({
		page
	}, testInfo) => {
		await open(page, PULL_UP);
		await expect(heading(page)).toHaveText('Pull-up');
		await expect(logger(page).getByTestId('logger-load')).toContainText('Added weight');
		await expect(logger(page).getByTestId('logger-load')).toContainText(
			'Leave at 0 for bodyweight only'
		);
		await expect(amountField(page)).toHaveAttribute('aria-valuenow', '6');
		await expect(rpe(page, '8')).toBeChecked();
		await captureScreen(page, testInfo, 'workout-superset');

		// Nothing added: bodyweight only, so no weight. The partner is current in the same frame.
		expect(await completeInFrame(page)).toEqual({
			states: ['current', 'todo', 'todo'],
			exercise: 'Plank'
		});
		await expect(page.getByTestId('workout-side').locator('[aria-current]')).toHaveText(/Plank/);
		// The plank logs a time, in m:ss.
		await expect(logger(page).getByTestId('logger-amount')).toContainText('Time');
		await expect(amountField(page)).toHaveValue('0:45');
		await expect(rpe(page, '7')).toBeChecked();
		expect(await completeInFrame(page)).toEqual({
			states: ['done', 'current', 'todo'],
			exercise: 'Pull-up'
		});

		// A1 set 2, with 10 kg added.
		await expect(logger(page)).toContainText('Set 2 of 3');
		await enter(page, loadField(page), '10');
		expect((await completeInFrame(page)).exercise).toBe('Plank');

		await expect.poll(async () => (await setLogs(page)).length).toBe(3);
		const [first, plank, second] = await setLogs(page);
		const [pullUp, a2] = [kit.exercises[PULL_UP - 1]!, kit.exercises[PULL_UP]!];
		expect(first!.payload).toMatchObject({
			position: PULL_UP,
			exerciseId: pullUp.exercise.id,
			setIndex: 1,
			reps: 6,
			weight: null,
			seconds: null
		});
		expect(plank!.payload).toMatchObject({
			position: PULL_UP + 1,
			exerciseId: a2.exercise.id,
			setIndex: 1,
			reps: null,
			seconds: 45,
			weight: null,
			rpe: 7
		});
		expect(second!.payload).toMatchObject({
			position: PULL_UP,
			setIndex: 2,
			weight: 10,
			unit: 'kg'
		});
		// The move to the partner is device state, written with the set: a reload keeps it.
		await page.reload();
		await expect(heading(page)).toHaveText('Plank');
	});

	test('logging never waits for the network: with every /api request aborted, rows complete in the same frame', async ({
		page
	}) => {
		await page.route('**/api/**', (route) => route.abort());
		await open(page);
		await expect(heading(page)).toHaveText('Back squat');
		// The top set starts from last time's: 100 kg × 5 at the target RPE.
		await expect(loadField(page)).toHaveAttribute('aria-valuenow', '100');
		await expect(logger(page).getByTestId('logger-load')).toContainText('From last time');
		expect((await completeInFrame(page)).states).toEqual(['done', 'current', 'todo', 'todo']);
		// The back-off works its load out from today's top set.
		await expect(logger(page).getByTestId('logger-load')).toContainText("From today's top set");
		expect((await completeInFrame(page)).states).toEqual(['done', 'done', 'current', 'todo']);
		await expect.poll(async () => (await setLogs(page)).length).toBe(2);
	});

	test('the first Complete set once the store can write is done in the frame after the tap, however slow the store loads', async ({
		page
	}) => {
		// Hold the store's chunk (online.ts, from Vite's manifest) for a second.
		const manifest = JSON.parse(
			readFileSync(path.resolve(import.meta.dirname, CLIENT, '.vite/manifest.json'), 'utf8')
		) as Record<string, { file: string }>;
		await page.route(`**/${manifest['src/lib/client/workout/online.ts']!.file}`, async (route) => {
			await new Promise((resolve) => setTimeout(resolve, 1000));
			await route.continue();
		});
		await seedWorkout(page, kit);
		await gotoWorkout(page);
		// The logger shows before the store opens, and a tap then waits for it
		// (workout-early-taps.e2e.ts); tap as soon as the store is open (data-store).
		await expect(page.getByTestId('complete-set')).toBeVisible();
		await expect(page.locator('main#main[data-store]')).toBeAttached();
		expect((await completeInFrame(page)).states).toEqual(['done', 'current', 'todo', 'todo']);
	});

	test('a time is at least 0:01: Home stops there, and that is what is logged', async ({
		page
	}) => {
		await open(page, PULL_UP + 1);
		await expect(heading(page)).toHaveText('Plank');
		await amountField(page).press('Home');
		await expect(amountField(page)).toHaveValue('0:01');
		await logger(page).getByTestId('complete-set').click();
		await expect.poll(async () => (await setLogs(page)).map((m) => m.payload.seconds)).toEqual([1]);
	});

	test('a failed write reads "Not saved on this device", and Retry writes it once', async ({
		page
	}, testInfo) => {
		await open(page, LEG_PRESS);
		await enter(page, loadField(page), '100');
		await failPuts(page);
		// Shown at once, as every set is (done, or already not saved when the failed write is that
		// quick); then the row says it was not saved.
		const [first, ...rest] = (await completeInFrame(page)).states;
		expect(first).toMatch(/^(done|not-saved)$/);
		expect(rest).toEqual(['current', 'todo']);
		await expect(rows(page).first()).toHaveAttribute('data-state', 'not-saved');
		await expect(rows(page).first()).toContainText('Not saved on this device');
		const notice = page.getByTestId('not-saved');
		await expect(notice).toContainText('The device is out of space.');
		// It is part of the thumb zone, and Complete set stays in reach beside it.
		await expect(notice).toBeInViewport({ ratio: 1 });
		await expect(logger(page).getByTestId('complete-set')).toBeInViewport({ ratio: 1 });
		expect(await setLogs(page)).toEqual([]);
		await captureScreen(page, testInfo, 'workout-not-saved');
		expect(await audit(page)).toEqual([]);

		await liftPut(page);
		await notice.getByRole('button', { name: 'Retry' }).click();
		await expect(notice).toBeHidden();
		await expect(rows(page).first()).toHaveAttribute('data-state', 'done');
		const logs = await setLogs(page);
		expect(logs).toHaveLength(1);
		expect(logs[0]!.payload).toMatchObject({ setIndex: 1, weight: 100, reps: 10 });
	});

	test('the logger never moves between sets, and nothing shifts', async ({ page }) => {
		// Sync refused rather than held, so the network idles between taps (expectStableBoxes
		// waits for it).
		await page.route('**/api/workouts/**', (route) => route.abort());
		await open(page, 1, 'real');
		const box = await logger(page).boundingBox();
		// It sits at the foot of the screen, in the thumb zone.
		expect(Math.abs(box!.y + box!.height - page.viewportSize()!.height)).toBeLessThanOrEqual(1);
		const chromium = test.info().project.use.browserName === 'chromium';
		if (chromium) {
			await page.evaluate(() => {
				const shifts: { value: number; input: boolean }[] = [];
				new PerformanceObserver((list) => {
					for (const entry of list.getEntries() as unknown as {
						value: number;
						hadRecentInput: boolean;
					}[]) {
						shifts.push({ value: entry.value, input: entry.hadRecentInput });
					}
				}).observe({ type: 'layout-shift' });
				Object.assign(window, { __shifts: shifts });
			});
		}
		// The logger, its controls and Complete set keep their boxes from set to set.
		const parts = [
			logger(page),
			logger(page).getByTestId('logger-load').locator('.row'),
			logger(page).getByTestId('logger-amount').locator('.row'),
			logger(page).getByTestId('rpe-chips'),
			logger(page).getByTestId('complete-set')
		];
		// Real taps, as the owner's: what they move counts as caused by input, as CLS reads it.
		for (let set = 0; set < 3; set += 1) {
			await expectStableBoxes(page, parts, () => logger(page).getByTestId('complete-set').click());
		}
		await expect(rows(page).nth(3)).toHaveAttribute('data-state', 'current');
		if (chromium) {
			const shifts = await page.evaluate(
				() =>
					(
						window as unknown as {
							__shifts: { value: number; input: boolean }[];
						}
					).__shifts
			);
			// Nothing moves that a tap did not cause: no late shift once a set is logged (CLS 0). The
			// card above changes with the set at hand, as the tap asks; the logger's parts are
			// checked box by box above.
			expect(shifts.filter((s) => !s.input).reduce((sum, s) => sum + s.value, 0)).toBe(0);
		}
	});

	test('with a 34 px home indicator, the logger clears it', async ({ page }) => {
		await open(page);
		const before = await logger(page).evaluate((el) =>
			parseFloat(getComputedStyle(el).paddingBottom)
		);
		await forceSafeArea(page, { bottom: 34 });
		const after = await logger(page).evaluate((el) =>
			parseFloat(getComputedStyle(el).paddingBottom)
		);
		expect(after).toBe(before + 34);
		const box = await logger(page).boundingBox();
		expect(Math.abs(box!.y + box!.height - page.viewportSize()!.height)).toBeLessThanOrEqual(1);
	});

	test('steppers and chips are at least 44 px; nothing scrolls sideways at 393 px or 150 % text', async ({
		page
	}) => {
		await open(page, PULL_UP);
		const targets = logger(page).locator('button, .chip');
		const count = await targets.count();
		// The steppers' − and +, the RPE chips, Missed reps and Skip set, and Complete set.
		expect(count).toBe(4 + 10 + 2 + 1);
		for (let i = 0; i < count; i += 1) {
			const box = await targets.nth(i).boundingBox();
			expect(box!.width, `target ${i}`).toBeGreaterThanOrEqual(44);
			expect(box!.height, `target ${i}`).toBeGreaterThanOrEqual(44);
		}
		await expectNoSideScroll(page);
		await page.evaluate(() => (document.documentElement.style.fontSize = '150%'));
		await expectNoSideScroll(page);
		const chip = await logger(page).locator('.chip').last().boundingBox();
		expect(chip!.height).toBeGreaterThanOrEqual(44);
	});

	for (const theme of ['dark', 'light'] as const) {
		test(`no WCAG A/AA violations while logging (${theme} theme)`, async ({ page }) => {
			await page.addInitScript(
				(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
				theme
			);
			await open(page, PULL_UP);
			expect(await audit(page), 'logger').toEqual([]);
			await failPuts(page);
			await completeInFrame(page);
			await expect(page.getByTestId('not-saved')).toBeVisible();
			expect(await audit(page), 'not saved').toEqual([]);
		});
	}
});

test.describe('logging offline (service worker)', () => {
	// Playwright emulates offline for service-worker traffic only in Chromium.
	test.skip(({ browserName }) => browserName !== 'chromium', 'offline emulation is Chromium-only');

	test('two sets logged offline are still there after an offline reload, in the outbox', async ({
		page,
		context
	}) => {
		await page.goto('/workout');
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
			timeout: 15_000
		});
		const workoutId = await seedWorkout(page, kit);
		await setPosition(page, workoutId, LEG_PRESS);
		await context.setOffline(true);
		await page.goto('/workout');
		await expect(page.locator('main#main[data-store]')).toBeAttached();
		await enter(page, loadField(page), '110');
		await completeInFrame(page);
		await completeInFrame(page);
		await expect.poll(async () => (await setLogs(page)).length).toBe(2);

		await page.reload();
		await expect(page.locator('main#main[data-ready]')).toBeAttached();
		await expect(rows(page)).toHaveText([
			/110 kg × 10 reps · RPE 7\s*Done$/,
			/110 kg × 10 reps · RPE 7\s*Done$/,
			/Now$/
		]);
		expect((await setLogs(page)).map((m) => m.payload.setIndex)).toEqual([1, 2]);
		await context.setOffline(false);
	});
});
