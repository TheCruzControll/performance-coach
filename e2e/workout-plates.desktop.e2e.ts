/**
 * The plate calculator from a set row in a desktop window (1440 × 900): it is a dialog centred in
 * the window, fully usable by keyboard (the row's plate button, the Bar row and its sheet, Bar
 * and plates and a plate's sheet), with hover and focus-visible states on the plate button and
 * the rows. In a pick-one sheet the arrows move the pick and keep it open, and Enter closes it, back
 * on its row; Escape closes each sheet in turn, the last returning focus to the row's button.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { boxOf, expectNoSideScroll } from './desktop';
import { captureScreen } from './support';
import { gotoWorkout, seedWorkout, workoutDay } from './workout-support';

async function open(page: Page) {
	const { strength } = await workoutDay();
	await seedWorkout(page, strength);
	await gotoWorkout(page);
	await expect(page.locator('main#main[data-store]')).toBeAttached();
}

/** The back squat's second set (≈ 97.5 kg) and its plate button. */
const plates = (page: Page) =>
	page.getByTestId('workout-main').getByTestId('set').nth(1).getByTestId('set-plates');
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Plates per side' });
const result = (page: Page) => dialog(page).getByTestId('plates-result');

/** A sheet's own panel, the first: a pick-one row's sheet (PickRow) nests inside its body. */
const panel = (sheet: Locator) => sheet.locator('.sheet').first();

/** How far `sheet`'s panel is from the window's centre, the larger of the two ways. */
async function offCentre(sheet: Locator) {
	const [window, box] = [await boxOf(sheet), await boxOf(panel(sheet))];
	return Math.max(
		Math.abs(box.x + box.width / 2 - (window.x + window.width / 2)),
		Math.abs(box.y + box.height / 2 - (window.y + window.height / 2))
	);
}

const style = (target: Locator, property: string) =>
	target.evaluate((el, property) => getComputedStyle(el).getPropertyValue(property), property);

/** Tabs from where the focus is until `target` has it, as a keyboard user gets there. */
async function tabTo(page: Page, target: Locator) {
	for (let i = 0; i < 40; i += 1) {
		if (await target.evaluate((el) => el === document.activeElement)) return;
		await page.keyboard.press('Tab');
	}
	await expect(target).toBeFocused();
}

/** The hover state: `property` changes under the pointer and comes back without it. */
async function expectHover(page: Page, target: Locator, property: string) {
	await page.mouse.move(0, 0);
	const rest = await style(target, property);
	await target.hover();
	await expect.poll(() => style(target, property)).not.toBe(rest);
	await page.mouse.move(0, 0);
	await expect.poll(() => style(target, property)).toBe(rest);
}

const expectRing = async (target: Locator) => {
	await expect(target).toBeFocused();
	await expect.poll(() => style(target, 'outline-style')).toBe('solid');
};

test.describe('the plate calculator on a desktop', () => {
	// gotoWorkout holds /api/workouts/* with page.route, which WebKit applies only without a worker.
	test.use({ serviceWorkers: 'block' });

	test('a centred dialog, by keyboard from the row to the plates, with hover and focus states', async ({
		page
	}, testInfo) => {
		await open(page);
		await expectHover(page, plates(page), 'background-color');
		await page.locator('main#main').focus();
		await tabTo(page, plates(page));
		await expectRing(plates(page));
		await page.keyboard.press('Enter');

		await expect(result(page)).toHaveText('25 · 10 · 2.5 · 1.25');
		await expect
			.poll(() => dialog(page).evaluate((el) => el.contains(document.activeElement)))
			.toBe(true);
		await expect.poll(() => offCentre(dialog(page))).toBeLessThanOrEqual(1);
		expect((await boxOf(panel(dialog(page)))).width).toBeLessThanOrEqual(32 * 16);
		await expectNoSideScroll(page);

		// The Bar row: a ring and a hover tint; Enter opens its sheet, centred over the calculator's.
		// There the arrows move the pick and apply it, the sheet staying open; Enter closes it.
		const barRow = dialog(page).getByTestId('plates-bar-row');
		await expectHover(page, barRow, 'background-color');
		await tabTo(page, barRow);
		await expectRing(barRow);
		await page.keyboard.press('Enter');
		const bars = page.getByRole('dialog', { name: 'Bar', exact: true });
		await expect(bars).toBeVisible();
		await expect.poll(() => offCentre(bars)).toBeLessThanOrEqual(1);
		await tabTo(page, bars.getByRole('radio', { name: '20 kg bar' }));
		await page.keyboard.press('ArrowDown');
		const fifteen = bars.getByRole('radio', { name: '15 kg bar' });
		await expect(fifteen).toBeChecked();
		await expect(fifteen).toBeFocused();
		await expect(result(page)).toHaveText('25 · 15 · 1.25');
		await expect(bars, 'the arrows keep it open').toHaveClass(/\bvisible\b/);
		await page.keyboard.press('Enter');
		await expect(bars).toBeHidden();
		await expect(barRow).toBeFocused();
		await expect(barRow).toContainText('15 kg');

		// Bar and plates, by Enter: its sheet over the calculator's. The 25s' row opens theirs, where
		// the arrows move up to None and Enter closes it.
		const toggle = dialog(page).getByTestId('plates-inventory-toggle');
		await tabTo(page, toggle);
		await expectRing(toggle);
		await page.keyboard.press('Enter');
		const inventory = page.getByTestId('plates-inventory');
		await expect(inventory).toBeVisible();
		await expect.poll(() => offCentre(inventory)).toBeLessThanOrEqual(1);
		const twentyFives = inventory.getByTestId('plate-25');
		await expectHover(page, twentyFives, 'background-color');
		await tabTo(page, twentyFives);
		await expectRing(twentyFives);
		await page.keyboard.press('Enter');
		const pairs = page.getByRole('dialog', { name: '25 kg', exact: true });
		await expect(pairs).toBeVisible();
		await tabTo(page, pairs.getByRole('radio', { name: 'Any', exact: true }));
		for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowUp');
		const none = pairs.getByRole('radio', { name: 'None', exact: true });
		await expect(none).toBeChecked();
		await expect(none).toBeFocused();
		await expect(pairs, 'the arrows keep it open').toHaveClass(/\bvisible\b/);
		await page.keyboard.press('Enter');
		await expect(pairs).toBeHidden();
		await expect(twentyFives).toBeFocused();
		await expect(twentyFives).toContainText('None');
		await expect(result(page)).toHaveText('20 · 20 · 1.25');
		await captureScreen(page, testInfo, 'workout-plates');

		// Escape closes Bar and plates, back on its row, then the calculator.
		await page.keyboard.press('Escape');
		await expect(inventory).toBeHidden();
		await expect(toggle).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(dialog(page)).toBeHidden();
		await expect(plates(page)).toBeFocused();
	});
});
