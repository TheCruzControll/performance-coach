/**
 * The plate calculator from a set row on /workout (PRD §8): a set of a barbell or plate-loaded
 * exercise opens M1's calculator at that set's weight and unit, and the device's bar and plates,
 * edited inside it, are what the solver loads: kept per device and per unit, and shared with
 * Train's calculator. From the shared kit fixture seeded in IndexedDB; sync is held ('hold'),
 * so nothing here writes Postgres. The desktop dialog and the keyboard are
 * workout-plates.desktop.e2e.ts.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { PLATES_KEY } from '../src/lib/client/plates';
import { DB_NAME, STORES } from '../src/lib/client/workout/names';
import type { StrengthKit } from '../src/lib/domain/workout';
import { createMutation } from '../src/lib/domain/workout/mutations';
import { captureScreen } from './support';
import { gotoWorkout, injectMutation, seedWorkout, workoutDay } from './workout-support';

let kit: StrengthKit;
test.beforeAll(async () => {
	kit = (await workoutDay()).strength;
});

/** Makes `position` the stored workout's current exercise. */
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

/**
 * The back squat with its first set done at 102.5 kg × 5 (its back-off sets plan ≈ 97.5 kg), and
 * /workout open on it. Returns the workout's id.
 */
async function open(page: Page): Promise<string> {
	const workoutId = await seedWorkout(page, kit);
	const squat = kit.exercises[0]!;
	await injectMutation(
		page,
		createMutation('set.log', {
			workoutId,
			at: new Date().toISOString(),
			payload: {
				position: 1,
				plannedLineage: squat.plannedLineage,
				setIndex: 1,
				exerciseId: squat.exercise.id,
				reps: 5,
				seconds: null,
				metres: null,
				weight: 102.5,
				assistance: null,
				unit: 'kg',
				rpe: 8,
				missedReps: 0,
				isWarmup: false,
				isExtra: false
			}
		})
	);
	await gotoWorkout(page);
	await expect(page.locator('main#main[data-store]')).toBeAttached();
	await expect(rows(page).first()).toHaveAttribute('data-state', 'done');
	return workoutId;
}

const card = (page: Page) => page.getByTestId('workout-main').getByTestId('exercise');
const rows = (page: Page) => page.getByTestId('workout-main').getByTestId('set');
const platesOf = (page: Page, index: number) => rows(page).nth(index).getByTestId('set-plates');
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Plate calculator' });
const result = (page: Page) => dialog(page).getByTestId('plates-result');
const target = (page: Page) => dialog(page).getByRole('spinbutton', { name: 'Target weight' });
const bar = (page: Page, name: string) =>
	dialog(page).getByRole('radiogroup', { name: 'Bar' }).getByRole('radio', { name });
/** The inventory editor's choice for one plate: 'None', '1', '2', '3' or 'Any'. */
const plate = (page: Page, weight: string, choice: string) =>
	dialog(page)
		.getByRole('radiogroup', { name: `${weight} plates`, exact: true })
		.getByRole('radio', { name: choice, exact: true });

async function openInventory(page: Page) {
	const toggle = dialog(page).getByRole('button', { name: 'Bar and plates' });
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-expanded', 'true');
	await expect(dialog(page).getByTestId('plates-inventory')).toBeVisible();
}

const stored = (page: Page) =>
	page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), PLATES_KEY);

async function audit(page: Page): Promise<string[]> {
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) =>
		v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
	);
}

test.describe('the plate calculator from a set (IndexedDB only)', () => {
	// gotoWorkout holds /api/workouts/* with page.route, which WebKit applies only without a worker.
	test.use({ serviceWorkers: 'block' });

	test('a 102.5 kg set opens at 102.5 kg on the 20 kg bar; the edited inventory is what loads, after a reload and in Train', async ({
		page
	}, testInfo) => {
		await open(page);
		await expect(card(page).getByTestId('set-plates')).toHaveCount(4);
		const box = await platesOf(page, 0).boundingBox();
		expect(Math.min(box!.width, box!.height), 'a 44 px target').toBeGreaterThanOrEqual(44);

		await platesOf(page, 0).click();
		await expect(dialog(page)).toBeVisible();
		await expect(dialog(page)).toContainText('Set 1 · Back squat');
		await expect(target(page)).toHaveAttribute('aria-valuenow', '102.5');
		await expect(bar(page, '20 kg bar')).toHaveAttribute('aria-checked', 'true');
		await expect(result(page)).toHaveText(/^25 · 15 · 1\.25\s*kg per side$/);
		await expect(
			dialog(page).getByRole('img', { name: 'Per side: 25, 15, 1.25 kg' })
		).toBeVisible();
		await captureScreen(page, testInfo, 'workout-plates');

		// No 25s, and the 15 kg bar: recalculated from what is left.
		await openInventory(page);
		await plate(page, '25 kg', 'None').click();
		await expect(plate(page, '25 kg', 'None')).toHaveAttribute('aria-checked', 'true');
		await bar(page, '15 kg bar').click();
		await expect(result(page)).toHaveText(/^20 · 20 · 2\.5 · 1\.25\s*kg per side$/);
		await captureScreen(page, testInfo, 'workout-plates-inventory');

		// One pair of 20s forces another loading, still exact.
		await plate(page, '20 kg', '1').click();
		await expect(result(page)).toHaveText(/^20 · 15 · 5 · 2\.5 · 1\.25\s*kg per side$/);
		await expect(dialog(page).getByTestId('plates-warning')).toHaveCount(0);

		await dialog(page).getByRole('button', { name: 'Close' }).click();
		await expect(dialog(page)).toBeHidden();
		await expect(platesOf(page, 0)).toBeFocused();
		expect((await stored(page)).kg).toMatchObject({
			bar: 15,
			plates: [{ weight: 20, pairs: 1 }, { weight: 15 }, { weight: 10 }, { weight: 5 }].concat(
				[2.5, 1.25, 0.5, 0.25].map((weight) => ({ weight }))
			)
		});

		// After a reload, the planned ≈ 97.5 kg set loads on the same bar and plates.
		await page.reload();
		await expect(page.locator('main#main[data-store]')).toBeAttached();
		await platesOf(page, 1).click();
		await expect(dialog(page)).toContainText('Set 2 · Back squat');
		await expect(target(page)).toHaveAttribute('aria-valuenow', '97.5');
		await expect(bar(page, '15 kg bar')).toHaveAttribute('aria-checked', 'true');
		await expect(result(page)).toHaveText(/^20 · 15 · 5 · 1\.25\s*kg per side$/);
		await page.keyboard.press('Escape');
		await expect(dialog(page)).toBeHidden();
		await expect(platesOf(page, 1)).toBeFocused();

		// Train's calculator uses the same inventory: 100 kg on the 15 kg bar, with one pair of 20s.
		// Hydrated once the resume bar has looked: never networkidle, which the held sync of this
		// workout's pending changes (the bar's engine) keeps from happening.
		await page.goto('/train');
		await expect(page.locator('[data-testid="resume-slot"][data-looked="/train"]')).toBeAttached();
		await page.getByTestId('open-plates').click();
		await expect(bar(page, '15 kg bar')).toHaveAttribute('aria-checked', 'true');
		await expect(result(page)).toHaveText(/^20 · 15 · 5 · 2\.5\s*kg per side$/);
	});

	test('pounds keep their own inventory, on the 45 lb bar', async ({ page }) => {
		await open(page);
		await platesOf(page, 1).click();
		await dialog(page).getByRole('radio', { name: 'Pounds' }).click();
		await expect(target(page)).toHaveAttribute('aria-valuenow', '215');
		await expect(bar(page, '45 lb bar')).toHaveAttribute('aria-checked', 'true');
		await expect(result(page)).toHaveText(/^45 · 35 · 5\s*lb per side$/);

		await openInventory(page);
		await plate(page, '45 lb', 'None').click();
		await expect(result(page)).toHaveText(/^35 · 25 · 25\s*lb per side$/);

		// Kilograms are as they were: the 20 kg bar and every plate.
		await dialog(page).getByRole('radio', { name: 'Kilograms' }).click();
		await expect(bar(page, '20 kg bar')).toHaveAttribute('aria-checked', 'true');
		await expect(plate(page, '25 kg', 'Any')).toHaveAttribute('aria-checked', 'true');
		await expect(result(page)).toHaveText(/^25 · 10 · 2\.5 · 1\.25\s*kg per side$/);
		const saved = await stored(page);
		expect(saved.kg).toBeUndefined();
		expect(saved.lb.bar).toBe(45);
		expect(saved.lb.plates.map((p: { weight: number }) => p.weight)).not.toContain(45);

		await page.reload();
		await expect(page.locator('main#main[data-store]')).toBeAttached();
		await platesOf(page, 1).click();
		await dialog(page).getByRole('radio', { name: 'Pounds' }).click();
		await expect(result(page)).toHaveText(/^35 · 25 · 25\s*lb per side$/);
	});

	test('the plank and the pull-up rows have no plate button; the leg press has one per set', async ({
		page
	}) => {
		const workoutId = await open(page);
		for (const [position, name, count] of [
			[2, 'Leg press', 3],
			[4, 'Pull-up', 0],
			[5, 'Plank', 0]
		] as const) {
			await setPosition(page, workoutId, position);
			await page.reload();
			await expect(card(page).getByRole('heading', { level: 2 })).toHaveText(name);
			await expect(rows(page)).toHaveCount(3);
			await expect(card(page).getByTestId('set-plates')).toHaveCount(count);
		}
	});

	for (const theme of ['dark', 'light'] as const) {
		test(`the calculator and its inventory have no WCAG A/AA violations (${theme} theme)`, async ({
			page
		}) => {
			await page.addInitScript(
				(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
				theme
			);
			await open(page);
			expect(await audit(page), 'the rows').toEqual([]);
			await platesOf(page, 0).click();
			await expect(result(page)).toBeVisible();
			await openInventory(page);
			await page.waitForTimeout(500); // let the sheet's entrance settle before measuring contrast
			if (theme === 'light')
				await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
			expect(await audit(page), 'the calculator').toEqual([]);
		});
	}
});
