/**
 * The strength view in a desktop window (1440 × 900): the session's exercise list beside the
 * current exercise, the current one marked aria-current, long names fitting both columns.
 */
import { expect, test, type Page } from '@playwright/test';
import { DB_NAME, STORES } from '../src/lib/client/workout/names';
import { BELOW_DESKTOP_WIDTH, boxOf, DESKTOP_WIDTHS, expectNoSideScroll } from './desktop';
import { captureScreen } from './support';
import { gotoWorkout, seedWorkout, workoutDay } from './workout-support';

const LONG = 'Single-arm dumbbell Bulgarian split squat with a three-second pause';

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

const side = (page: Page) => page.getByTestId('workout-side');
const card = (page: Page) => page.getByTestId('workout-main').getByTestId('exercise');

test.describe('the strength view on a desktop', () => {
	// gotoWorkout holds /api/workouts/* with page.route, which WebKit applies only without a worker.
	test.use({ serviceWorkers: 'block' });

	test('the exercise list sits beside the current exercise, the current one marked', async ({
		page
	}, testInfo) => {
		const { strength } = await workoutDay();
		const workoutId = await seedWorkout(page, strength);
		await gotoWorkout(page);

		const list = await boxOf(side(page));
		const main = await boxOf(card(page));
		// The main column starts with the rest timer's kept place, the card under it.
		const column = await boxOf(page.getByTestId('workout-main'));
		const rest = await boxOf(page.getByTestId('rest-slot'));
		expect(list.x + list.width, 'the list ends before the exercise').toBeLessThan(main.x);
		expect(Math.abs(list.y - column.y), 'both start at the same height').toBeLessThanOrEqual(1);
		expect(Math.abs(rest.y - column.y), 'the rest’s place first').toBeLessThanOrEqual(1);
		expect(main.y, 'the card under it').toBeGreaterThanOrEqual(rest.y + rest.height);

		const rows = side(page).getByRole('listitem');
		await expect(rows).toHaveText([
			/^1\s*Back squat\s*0\/4\s*sets$/,
			/^2\s*Leg press\s*0\/3\s*sets$/,
			/^3\s*Romanian deadlift\s*0\/3\s*sets$/,
			/^A1\s*Pull-up\s*0\/3\s*sets$/,
			/^A2\s*Plank\s*0\/3\s*sets$/
		]);
		await expect(side(page).locator('[aria-current="step"]')).toHaveText(/Back squat/);
		await captureScreen(page, testInfo, 'workout-exercise');

		await setPosition(page, workoutId, 4);
		await page.reload();
		await expect(card(page).getByRole('heading', { level: 2 })).toHaveText('Pull-up');
		await expect(side(page).locator('[aria-current="step"]')).toHaveText(/^A1\s*Pull-up/);
		await expect(side(page).locator('[aria-current]')).toHaveCount(1);
	});

	test('long names fit both columns at every desktop width', async ({ page }) => {
		const { strength } = await workoutDay();
		const long = structuredClone(strength);
		long.exercises[0]!.exercise.name = LONG;
		await seedWorkout(page, long);
		await gotoWorkout(page);
		await expect(card(page).getByRole('heading', { level: 2 })).toHaveText(LONG);

		for (const width of [...DESKTOP_WIDTHS, BELOW_DESKTOP_WIDTH]) {
			await page.setViewportSize({ width, height: 900 });
			await expectNoSideScroll(page);
			if (width === BELOW_DESKTOP_WIDTH) continue;
			const list = await boxOf(side(page));
			const name = await boxOf(side(page).getByText(LONG));
			expect(name.x + name.width, `the name inside the list at ${width}px`).toBeLessThanOrEqual(
				list.x + list.width + 1
			);
			const main = await boxOf(card(page));
			const heading = await boxOf(card(page).getByRole('heading', { level: 2 }));
			expect(heading.x + heading.width).toBeLessThanOrEqual(main.x + main.width + 1);
		}
		// Below 1024 px the current exercise has the screen.
		await expect(side(page)).toBeHidden();
	});
});
