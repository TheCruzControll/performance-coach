/**
 * The plate calculator from a set row in a desktop window (1440 × 900): it is a dialog centred in
 * the window, fully usable by keyboard (the row's plate button, the bar presets, the inventory
 * editor's plates), with hover and focus-visible states on the plate button, the plates and the
 * presets; Escape returns focus to the row's button.
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
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Plate calculator' });
const result = (page: Page) => dialog(page).getByTestId('plates-result');

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

		await expect(result(page)).toHaveText(/^25 · 10 · 2\.5 · 1\.25\s*kg per side$/);
		await expect
			.poll(() => dialog(page).evaluate((el) => el.contains(document.activeElement)))
			.toBe(true);
		const window = await boxOf(dialog(page));
		const offCentre = async () => {
			const box = await boxOf(dialog(page).locator('.sheet'));
			return Math.max(
				Math.abs(box.x + box.width / 2 - (window.x + window.width / 2)),
				Math.abs(box.y + box.height / 2 - (window.y + window.height / 2))
			);
		};
		await expect.poll(offCentre).toBeLessThanOrEqual(1);
		expect((await boxOf(dialog(page).locator('.sheet'))).width).toBeLessThanOrEqual(32 * 16);
		await expectNoSideScroll(page);

		// The bar presets: one Tab stop, the arrows choose, with a ring and a hover state.
		const bars = dialog(page).getByRole('radiogroup', { name: 'Bar' });
		await expectHover(page, bars.getByRole('radio', { name: '15 kg bar' }), 'color');
		await tabTo(page, bars.getByRole('radio', { name: '20 kg bar' }));
		await expectRing(bars.getByRole('radio', { name: '20 kg bar' }));
		await page.keyboard.press('ArrowRight');
		await expect(bars.getByRole('radio', { name: '15 kg bar' })).toHaveAttribute(
			'aria-checked',
			'true'
		);
		await expect(result(page)).toHaveText(/^25 · 15 · 1\.25\s*kg per side$/);

		// Bar and plates, by Enter; the 25s go with Home (None), from their one Tab stop.
		const toggle = dialog(page).getByRole('button', { name: 'Bar and plates' });
		await tabTo(page, toggle);
		await expectRing(toggle);
		await page.keyboard.press('Enter');
		await expect(toggle).toHaveAttribute('aria-expanded', 'true');
		const twentyFives = dialog(page).getByRole('radiogroup', { name: '25 kg plates', exact: true });
		await expectHover(page, twentyFives.getByRole('radio', { name: '2', exact: true }), 'color');
		await tabTo(page, twentyFives.getByRole('radio', { name: 'Any' }));
		await expectRing(twentyFives.getByRole('radio', { name: 'Any' }));
		await page.keyboard.press('Home');
		await expectRing(twentyFives.getByRole('radio', { name: 'None' }));
		await expect(twentyFives.getByRole('radio', { name: 'None' })).toHaveAttribute(
			'aria-checked',
			'true'
		);
		await expect(result(page)).toHaveText(/^20 · 20 · 1\.25\s*kg per side$/);
		await captureScreen(page, testInfo, 'workout-plates');

		await page.keyboard.press('Escape');
		await expect(dialog(page)).toBeHidden();
		await expect(plates(page)).toBeFocused();
	});
});
