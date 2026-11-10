/**
 * The workout settings and Train's rest timer in a desktop window (1440 × 900): both sheets open
 * as dialogs centred in the window, every setting works from the keyboard, with hover and
 * :focus-visible states, and the rest timer's row sits in Train's tools column.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { boxOf, expectNoSideScroll, layoutWidth } from './desktop';
import { captureScreen } from './support';
import { gotoWorkout, seedWorkout, workoutDay } from './workout-support';

const settings = (page: Page) => page.getByTestId('workout-settings');
const panel = (dialog: Locator) => dialog.locator('.sheet');

const style = (target: Locator, property: string) =>
	target.evaluate((el, property) => getComputedStyle(el).getPropertyValue(property), property);

/** The dialog's panel is centred in the window, clear of its bottom edge, and phone-width-ish. */
async function expectCentredDialog(page: Page, dialog: Locator) {
	const box = await boxOf(panel(dialog));
	const width = await layoutWidth(page);
	const height = page.viewportSize()!.height;
	expect(Math.abs(box.x + box.width / 2 - width / 2), 'centred across').toBeLessThanOrEqual(2);
	expect(box.width, 'a dialog, not a stretched sheet').toBeLessThan(width / 2);
	expect(box.y + box.height, 'clear of the bottom edge').toBeLessThan(height - 8);
}

/** Tabs forward until `target` has the focus (at most `max` presses). */
async function tabTo(page: Page, target: Locator, max = 30) {
	for (let i = 0; i < max; i += 1) {
		if (await target.evaluate((el) => el === document.activeElement)) return;
		await page.keyboard.press('Tab');
	}
	await expect(target).toBeFocused();
}

test.describe('the workout settings on a desktop', () => {
	// gotoWorkout holds /api/workouts/* with page.route, which WebKit applies only without a worker.
	test.use({ serviceWorkers: 'block' });

	test('a centred dialog over the menu, every setting by keyboard, with hover and focus-visible states', async ({
		page
	}, testInfo) => {
		const { strength } = await workoutDay();
		await seedWorkout(page, strength);
		await gotoWorkout(page);
		await expect(page.locator('main#main[data-store]')).toBeAttached();

		// By keyboard: the menu, then Settings.
		const menuButton = page.getByTestId('workout-menu-button');
		await expect(menuButton).toBeVisible();
		await menuButton.focus();
		await page.keyboard.press('Enter');
		const menuSettings = page.getByTestId('workout-menu').getByTestId('menu-settings');
		await tabTo(page, menuSettings);
		await expect.poll(() => style(menuSettings, 'outline-style')).toBe('solid');
		await page.keyboard.press('Enter');
		await expect(settings(page)).toBeVisible();
		await expectCentredDialog(page, settings(page));
		await expectNoSideScroll(page);

		// A rest: arrows change it by 15 s, and it is kept at once.
		const main = settings(page).getByTestId('rest-main').getByRole('spinbutton');
		await tabTo(page, main);
		await expect.poll(() => style(main, 'outline-style')).toBe('solid');
		await page.keyboard.press('Escape'); // leaves the edit, not the dialog
		await expect(settings(page)).toBeVisible();
		await main.focus();
		await page.keyboard.press('ArrowUp');
		await expect(main).toHaveAttribute('aria-valuenow', '195');
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem('pc:workout:v1')))
			.toContain('"main":195');

		// A switch: Space flips it.
		const autoStart = settings(page).getByTestId('setting-autoStartRest');
		await tabTo(page, autoStart);
		await expect(autoStart).toBeChecked();
		await page.keyboard.press('Space');
		await expect(autoStart).not.toBeChecked();
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem('pc:workout:v1')))
			.toContain('"autoStartRest":false');

		// Hover: the stepper's buttons and the Close button change.
		await page.mouse.move(0, 0);
		for (const target of [
			settings(page).getByRole('button', { name: 'Increase Main lifts' }),
			settings(page).getByRole('button', { name: 'Close' })
		]) {
			await target.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
			const rest = await style(target, 'background-color');
			await target.hover();
			await expect.poll(() => style(target, 'background-color')).not.toBe(rest);
			await page.mouse.move(0, 0);
		}
		await captureScreen(page, testInfo, 'workout-settings');

		// Escape closes it, back to Settings in the menu.
		await page.keyboard.press('Escape');
		await expect(settings(page)).toBeHidden();
		await expect(menuSettings).toBeFocused();
	});
});

test.describe("Train's rest timer on a desktop", () => {
	test('its row sits in the tools column; the timer is a centred dialog, by keyboard', async ({
		page
	}) => {
		await page.goto('/train');
		await page.waitForLoadState('networkidle');
		const row = page.getByTestId('open-rest-timer');
		const tools = page.getByRole('region', { name: 'Tools' });
		const plates = await boxOf(page.getByTestId('open-plates'));
		const box = await boxOf(row);
		expect(Math.abs(box.x - plates.x), 'under the plate calculator').toBeLessThanOrEqual(1);
		expect(box.y).toBeGreaterThan(plates.y);
		const column = await boxOf(tools);
		expect(box.x).toBeGreaterThanOrEqual(column.x - 1);
		expect(box.x + box.width).toBeLessThanOrEqual(column.x + column.width + 1);

		// Hover (its border) and focus-visible on the row.
		await page.mouse.move(0, 0);
		const rest = await style(row, 'border-color');
		await row.hover();
		await expect.poll(() => style(row, 'border-color')).not.toBe(rest);
		await page.mouse.move(0, 0);
		await page.getByTestId('open-plates').focus();
		await page.keyboard.press('Tab');
		await expect(row).toBeFocused();
		await expect.poll(() => style(row, 'outline-style')).toBe('solid');

		await page.keyboard.press('Enter');
		const sheet = page.getByTestId('rest-timer-sheet');
		await expect(sheet).toBeVisible();
		await expectCentredDialog(page, sheet);
		const start = sheet.getByTestId('start-main-rest');
		await tabTo(page, start);
		await page.keyboard.press('Enter');
		await expect(sheet.getByTestId('rest-timer')).toHaveAttribute('data-phase', 'running');
		await page.keyboard.press('Escape');
		await expect(sheet).toBeHidden();
		await expect(row).toBeFocused();
		const timer = page.getByTestId('train-rest');
		await expect(timer).toBeVisible();
		const inline = await boxOf(timer);
		expect(inline.x + inline.width).toBeLessThanOrEqual(column.x + column.width + 1);
		await expectNoSideScroll(page);
	});
});
