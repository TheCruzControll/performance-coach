/**
 * The plate calculator from a set row on /workout (PRD §8): a set of a barbell or plate-loaded
 * exercise opens M1's calculator, 'Plates per side', at that set's weight and unit, and the
 * device's bar and plates, edited in Bar and plates (a sheet over it), are what the solver loads:
 * kept per device and per unit, and shared with Train's calculator. Bar, Units and each plate are
 * rows that open pick-one sheets (PickRow). From the shared kit fixture seeded in IndexedDB; sync is held ('hold'),
 * so nothing here writes Postgres. The desktop dialog and the keyboard are
 * workout-plates.desktop.e2e.ts.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { PLATES_KEY } from '../src/lib/client/plates';
import { DB_NAME, STORES } from '../src/lib/client/workout/names';
import type { StrengthKit } from '../src/lib/domain/workout';
import { createMutation } from '../src/lib/domain/workout/mutations';
import { openMore } from './program-support';
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
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Plates per side' });
const result = (page: Page) => dialog(page).getByTestId('plates-result');
const caption = (page: Page) => dialog(page).getByTestId('plates-caption');
const target = (page: Page) => dialog(page).getByRole('spinbutton', { name: 'Target weight' });
/** The Bar row: its value is the bar ('20 kg'). */
const barRow = (page: Page) => dialog(page).getByTestId('plates-bar-row');
const inventory = (page: Page) => page.getByTestId('plates-inventory');
/** A plate's row in Bar and plates, by its weight ('25'): its value is None, its pairs or Any. */
const plateRow = (page: Page, weight: string) => inventory(page).getByTestId(`plate-${weight}`);

/** A pick-one row's sheet (PickRow), titled by the row: a pick closes it. */
async function pickIn(page: Page, row: Locator, title: string, choice: string) {
	await row.click();
	const sheet = page.getByRole('dialog', { name: title, exact: true });
	await sheet.getByRole('radio', { name: choice, exact: true }).click();
	await expect(sheet).toBeHidden();
}

const pickBar = (page: Page, name: string) => pickIn(page, barRow(page), 'Bar', name);
const pickUnits = (page: Page, name: string) =>
	pickIn(page, dialog(page).getByTestId('plates-units-row'), 'Units', name);
/** A plate's pairs in Bar and plates: 'None', '1 pair', '2 pairs', '3 pairs' or 'Any'. */
const pickPlate = (page: Page, weight: string, unit: string, choice: string) =>
	pickIn(page, plateRow(page, weight), `${weight} ${unit}`, choice);

/** Bar and plates, its own sheet over the calculator's. */
async function openInventory(page: Page) {
	await dialog(page).getByTestId('plates-inventory-toggle').click();
	await expect(inventory(page)).toBeVisible();
}

/** Escape closes Bar and plates, back to the calculator. */
async function closeInventory(page: Page) {
	await page.keyboard.press('Escape');
	await expect(inventory(page)).toBeHidden();
	await expect(dialog(page)).toBeVisible();
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
		await expect(barRow(page)).toContainText('20 kg');
		await expect(result(page)).toHaveText('25 · 15 · 1.25');
		await expect(caption(page)).toHaveText('kg on each side, heaviest first');
		await captureScreen(page, testInfo, 'workout-plates');

		// No 25s, and the 15 kg bar: recalculated from what is left.
		await openInventory(page);
		await pickPlate(page, '25', 'kg', 'None');
		await expect(plateRow(page, '25')).toContainText('None');
		await captureScreen(page, testInfo, 'workout-plates-inventory');
		await closeInventory(page);
		await expect(dialog(page).getByTestId('plates-inventory-toggle')).toContainText(
			'No 25 kg plates'
		);
		await pickBar(page, '15 kg bar');
		await expect(barRow(page)).toContainText('15 kg');
		await expect(result(page)).toHaveText('20 · 20 · 2.5 · 1.25');

		// One pair of 20s forces another loading, still exact.
		await openInventory(page);
		await pickPlate(page, '20', 'kg', '1 pair');
		await expect(plateRow(page, '20')).toContainText('1 pair');
		await closeInventory(page);
		await expect(result(page)).toHaveText('20 · 15 · 5 · 2.5 · 1.25');
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
		await expect(barRow(page)).toContainText('15 kg');
		await expect(result(page)).toHaveText('20 · 15 · 5 · 1.25');
		await page.keyboard.press('Escape');
		await expect(dialog(page)).toBeHidden();
		await expect(platesOf(page, 1)).toBeFocused();

		// Train's calculator uses the same inventory: 100 kg on the 15 kg bar, with one pair of 20s.
		// Hydrated once the resume bar has looked: never networkidle, which the held sync of this
		// workout's pending changes (the bar's engine) keeps from happening.
		await page.goto('/train');
		await expect(page.locator('[data-testid="resume-slot"][data-looked="/train"]')).toBeAttached();
		await openMore(page);
		await page.getByTestId('open-plates').click();
		await expect(barRow(page)).toContainText('15 kg');
		await expect(result(page)).toHaveText('20 · 15 · 5 · 2.5');
	});

	test('pounds keep their own inventory, on the 45 lb bar', async ({ page }) => {
		await open(page);
		await platesOf(page, 1).click();
		await pickUnits(page, 'Pounds');
		await expect(dialog(page).getByTestId('plates-units-row')).toContainText('Pounds');
		await expect(target(page)).toHaveAttribute('aria-valuenow', '215');
		await expect(barRow(page)).toContainText('45 lb');
		await expect(result(page)).toHaveText('45 · 35 · 5');
		await expect(caption(page)).toHaveText('lb on each side, heaviest first');

		await openInventory(page);
		await pickPlate(page, '45', 'lb', 'None');
		await closeInventory(page);
		await expect(result(page)).toHaveText('35 · 25 · 25');

		// Kilograms are as they were: the 20 kg bar and every plate.
		await pickUnits(page, 'Kilograms');
		await expect(barRow(page)).toContainText('20 kg');
		await expect(dialog(page).getByTestId('plates-inventory-toggle')).toContainText(
			'What this gym has'
		);
		await openInventory(page);
		await expect(plateRow(page, '25')).toContainText('Any');
		await closeInventory(page);
		await expect(result(page)).toHaveText('25 · 10 · 2.5 · 1.25');
		const saved = await stored(page);
		expect(saved.kg).toBeUndefined();
		expect(saved.lb.bar).toBe(45);
		expect(saved.lb.plates.map((p: { weight: number }) => p.weight)).not.toContain(45);

		await page.reload();
		await expect(page.locator('main#main[data-store]')).toBeAttached();
		await platesOf(page, 1).click();
		await pickUnits(page, 'Pounds');
		await expect(result(page)).toHaveText('35 · 25 · 25');
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
		test(`the calculator, Bar and plates and a pick sheet have no WCAG A/AA violations (${theme} theme)`, async ({
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
			await page.waitForTimeout(500); // let the sheet's entrance settle before measuring contrast
			if (theme === 'light')
				await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
			expect(await audit(page), 'the calculator').toEqual([]);
			await openInventory(page);
			await page.waitForTimeout(500);
			expect(await audit(page), 'Bar and plates').toEqual([]);
			await plateRow(page, '25').click();
			await expect(page.getByRole('dialog', { name: '25 kg', exact: true })).toBeVisible();
			await page.waitForTimeout(500);
			expect(await audit(page), 'a plate’s pick sheet').toEqual([]);
		});
	}
});
