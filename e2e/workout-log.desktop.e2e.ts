/**
 * Logging a set in a desktop window (1440 × 900): the logger sits in the main column under the
 * set rows, not fixed; the steppers, the RPE chips and Complete set work by keyboard alone; and
 * every control shows a hover and a focus state.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Mutation } from '../src/lib/domain/workout';
import { DB_NAME, STORES } from '../src/lib/client/workout/names';
import { boxOf, expectNoSideScroll } from './desktop';
import { captureScreen } from './support';
import { gotoWorkout, readOutbox, seedWorkout, workoutDay } from './workout-support';

const LEG_PRESS = 2;

async function open(page: Page, position = 1) {
	const { strength } = await workoutDay();
	const workoutId = await seedWorkout(page, strength);
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
	await gotoWorkout(page);
	await expect(page.locator('main#main[data-store]')).toBeAttached();
	await expect(logger(page)).toBeVisible();
}

const logger = (page: Page) => page.getByTestId('set-logger');
const card = (page: Page) => page.getByTestId('workout-main').getByTestId('exercise');
const loadField = (page: Page) => logger(page).getByTestId('logger-load').getByRole('spinbutton');
const amountField = (page: Page) =>
	logger(page).getByTestId('logger-amount').getByRole('spinbutton');
const setLogs = async (page: Page) =>
	(await readOutbox(page))
		.map((entry) => entry.envelope)
		.filter((m): m is Extract<Mutation, { type: 'set.log' }> => m.type === 'set.log');

/** A computed style of `target`, or of the chip face a radio draws. */
const style = (target: Locator, property: string, face = false) =>
	target.evaluate(
		(el, { property, face }) => {
			const shown = face ? el.nextElementSibling! : el;
			return getComputedStyle(shown).getPropertyValue(property);
		},
		{ property, face }
	);

test.describe('logging a set on a desktop', () => {
	// gotoWorkout holds /api/workouts/* with page.route, which WebKit applies only without a worker.
	test.use({ serviceWorkers: 'block' });

	test('the logger sits in the main column under the set rows, not fixed', async ({
		page
	}, testInfo) => {
		await open(page);
		expect(await logger(page).evaluate((el) => getComputedStyle(el).position)).toBe('static');
		const main = await boxOf(card(page));
		const box = await boxOf(logger(page));
		expect(box.y, 'under the set rows').toBeGreaterThan(main.y + main.height);
		expect(Math.abs(box.x - main.x), 'in the main column').toBeLessThanOrEqual(1);
		expect(Math.abs(box.width - main.width), 'as wide as the column').toBeLessThanOrEqual(1);
		// The two steppers side by side.
		const load = await boxOf(logger(page).getByTestId('logger-load'));
		const amount = await boxOf(logger(page).getByTestId('logger-amount'));
		expect(Math.abs(load.y - amount.y)).toBeLessThanOrEqual(1);
		expect(load.x + load.width).toBeLessThan(amount.x);
		await expectNoSideScroll(page);
		// Scrolling moves it with the page: it is not stuck to the window.
		await page.mouse.wheel(0, 200);
		await expect.poll(async () => (await boxOf(logger(page))).y).toBeLessThan(box.y - 100);
		await page.mouse.wheel(0, -200);
		await captureScreen(page, testInfo, 'workout-logging');
	});

	test('by keyboard: arrows and Page keys step, arrows move within the RPE chips, Enter logs', async ({
		page
	}) => {
		await open(page, LEG_PRESS);
		await loadField(page).focus();
		await page.keyboard.press('ArrowUp');
		await expect(loadField(page)).toHaveAttribute('aria-valuenow', '2.5');
		await page.keyboard.press('PageUp');
		await expect(loadField(page)).toHaveAttribute('aria-valuenow', '12.5');
		await page.keyboard.press('PageUp');
		await page.keyboard.press('ArrowDown');
		await expect(loadField(page)).toHaveAttribute('aria-valuenow', '20');
		await page.keyboard.press('PageDown');
		await expect(loadField(page)).toHaveAttribute('aria-valuenow', '10');

		await amountField(page).focus();
		await page.keyboard.press('ArrowDown');
		await expect(amountField(page)).toHaveAttribute('aria-valuenow', '9');
		await page.keyboard.press('PageUp');
		await expect(amountField(page)).toHaveAttribute('aria-valuenow', '14');
		await page.keyboard.press('PageDown');

		// The RPE chips are one Tab stop: Tab (past the stepper's +) lands on the chosen one, and
		// the arrows move the choice.
		await page.keyboard.press('Tab');
		await page.keyboard.press('Tab');
		const chosen = logger(page).getByRole('radio', { name: '7', exact: true });
		await expect(chosen).toBeFocused();
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ArrowRight');
		const eight = logger(page).getByRole('radio', { name: '8', exact: true });
		await expect(eight).toBeFocused();
		await expect(eight).toBeChecked();
		await page.keyboard.press('Tab');
		await expect(logger(page).getByTestId('complete-set')).toBeFocused();
		await page.keyboard.press('Enter');

		await expect(card(page).getByTestId('set').first()).toHaveAttribute('data-state', 'done');
		await expect.poll(async () => (await setLogs(page)).length).toBe(1);
		expect((await setLogs(page))[0]!.payload).toMatchObject({ weight: 10, reps: 9, rpe: 8 });
		// Focus stays on Complete set, so Enter logs the next set too.
		await expect(logger(page).getByTestId('complete-set')).toBeFocused();
		await page.keyboard.press('Enter');
		await expect.poll(async () => (await setLogs(page)).length).toBe(2);
		expect((await setLogs(page))[1]!.payload).toMatchObject({ setIndex: 2, weight: 10 });
	});

	test('every control has a focus ring and a hover state', async ({ page }, testInfo) => {
		await open(page, LEG_PRESS);
		const chip = logger(page).getByRole('radio', { name: '6', exact: true });
		const background = await style(chip, 'background-color', true);
		await chip.hover();
		await expect.poll(() => style(chip, 'background-color', true)).not.toBe(background);

		const complete = logger(page).getByTestId('complete-set');
		const fill = await style(complete, 'background-color');
		await complete.hover();
		await expect.poll(() => style(complete, 'background-color')).not.toBe(fill);
		await captureScreen(page, testInfo, 'workout-logging-hover');
		await page.mouse.move(0, 0);

		// Keyboard focus: each control, in Tab order, shows a ring of at least 2 px.
		const plus = logger(page)
			.getByTestId('logger-load')
			.getByRole('button', { name: /Increase/ });
		const controls: [Locator, boolean][] = [
			[plus, false],
			[loadField(page), false],
			[logger(page).getByRole('radio', { name: '7', exact: true }), true],
			[complete, false]
		];
		for (const [control, face] of controls) {
			await control.focus();
			await page.keyboard.press('Shift+Tab');
			await page.keyboard.press('Tab');
			await expect(control).toBeFocused();
			const width = parseFloat(await style(control, 'outline-width', face));
			const outline = await style(control, 'outline-style', face);
			const shadow = await style(control, 'box-shadow', face);
			expect((width >= 2 && outline !== 'none') || shadow !== 'none', `${control}`).toBe(true);
		}
		await logger(page).getByRole('radio', { name: '7', exact: true }).focus();
		await captureScreen(page, testInfo, 'workout-logging-focus');
	});
});
