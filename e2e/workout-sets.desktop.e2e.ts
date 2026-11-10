/**
 * Set actions in a desktop window (1440 × 900): the set editor is a dialog centred in the window
 * (focus moves in, Escape closes, focus returns to the row), every field works by keyboard, and
 * the set rows show a hover and a focus state.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Mutation } from '../src/lib/domain/workout';
import { boxOf, expectNoSideScroll } from './desktop';
import { captureScreen } from './support';
import { gotoWorkout, readOutbox, seedWorkout, workoutDay } from './workout-support';

async function open(page: Page) {
	const { strength } = await workoutDay();
	await seedWorkout(page, strength);
	await gotoWorkout(page);
	await expect(page.locator('main#main[data-store]')).toBeAttached();
	await page.getByTestId('complete-set').click();
	await expect(row(page)).toHaveAttribute('data-state', 'done');
}

const row = (page: Page) => page.getByTestId('workout-main').getByTestId('set').first();
const rowButton = (page: Page) => row(page).getByRole('button', { name: /^Edit set/ });
const editor = (page: Page) => page.getByTestId('set-editor');
const sheet = (page: Page) => editor(page).locator('.sheet');
const edits = async (page: Page) =>
	(await readOutbox(page))
		.map((entry) => entry.envelope)
		.filter((m): m is Extract<Mutation, { type: 'set.edit' }> => m.type === 'set.edit');

const style = (target: Locator, property: string) =>
	target.evaluate((el, property) => getComputedStyle(el).getPropertyValue(property), property);

/** Tabs from the page's start until `target` has focus, as a keyboard user gets there. */
async function tabTo(page: Page, target: Locator) {
	await page.locator('main#main').focus();
	for (let i = 0; i < 40; i += 1) {
		if (await target.evaluate((el) => el === document.activeElement)) return;
		await page.keyboard.press('Tab');
	}
	await expect(target).toBeFocused();
}

test.describe('set actions on a desktop', () => {
	// gotoWorkout holds /api/workouts/* with page.route, which WebKit applies only without a worker.
	test.use({ serviceWorkers: 'block' });

	test('the editor is a dialog centred in the window: focus moves in, Escape closes, focus returns to the row', async ({
		page
	}, testInfo) => {
		await open(page);
		await tabTo(page, rowButton(page));
		await page.keyboard.press('Enter');
		await expect(editor(page).getByRole('heading', { name: 'Edit set 1' })).toBeVisible();
		await expect
			.poll(() => editor(page).evaluate((dialog) => dialog.contains(document.activeElement)))
			.toBe(true);
		// Centred in the window (the dialog's box, which spans it), once it has risen into place.
		const window = await boxOf(editor(page));
		const offCentre = async () => {
			const box = await boxOf(sheet(page));
			return Math.max(
				Math.abs(box.x + box.width / 2 - (window.x + window.width / 2)),
				Math.abs(box.y + box.height / 2 - (window.y + window.height / 2))
			);
		};
		await expect.poll(offCentre).toBeLessThanOrEqual(1);
		const box = await boxOf(sheet(page));
		expect(box.width).toBeLessThanOrEqual(32 * 16);
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'workout-set-edit');

		await page.keyboard.press('Escape');
		await expect(editor(page)).toBeHidden();
		await expect(rowButton(page)).toBeFocused();
		expect(await edits(page)).toEqual([]);
	});

	test('every field works by keyboard, and Enter on Save sends the edit', async ({ page }) => {
		await open(page);
		await tabTo(page, rowButton(page));
		await page.keyboard.press('Enter');
		const load = editor(page).getByTestId('edit-load').getByRole('spinbutton');
		const amount = editor(page).getByTestId('edit-amount').getByRole('spinbutton');
		const missed = editor(page).getByTestId('edit-missed').getByRole('spinbutton');
		await expect(load).toBeVisible();

		await tabTo(page, load);
		await page.keyboard.press('ArrowUp');
		await expect(load).toHaveAttribute('aria-valuenow', '102.5');
		await tabTo(page, amount);
		await page.keyboard.press('ArrowDown');
		await expect(amount).toHaveAttribute('aria-valuenow', '4');
		await tabTo(page, missed);
		await page.keyboard.press('ArrowUp');
		await expect(missed).toHaveAttribute('aria-valuenow', '1');
		const seven = editor(page).getByRole('radio', { name: '7', exact: true });
		await tabTo(page, seven);
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ArrowRight');
		await expect(editor(page).getByRole('radio', { name: '8', exact: true })).toBeChecked();
		const warmUp = editor(page).getByRole('switch', { name: 'Warm-up' });
		await tabTo(page, warmUp);
		await page.keyboard.press('Space');
		await expect(warmUp).toBeChecked();
		await tabTo(page, editor(page).getByTestId('save-set'));
		await page.keyboard.press('Enter');

		await expect(editor(page)).toBeHidden();
		await expect(rowButton(page)).toBeFocused();
		await expect.poll(async () => (await edits(page)).length).toBe(1);
		expect((await edits(page))[0]!.payload).toMatchObject({
			weight: 102.5,
			reps: 4,
			missedReps: 1,
			rpe: 8,
			isWarmup: true
		});
	});

	test('a set row has a hover state and a focus ring', async ({ page }, testInfo) => {
		await open(page);
		const button = rowButton(page);
		const border = await style(button, 'border-top-color');
		await button.hover();
		await expect.poll(() => style(button, 'border-top-color')).not.toBe(border);
		expect(await style(button, 'cursor')).toBe('pointer');
		await captureScreen(page, testInfo, 'workout-set-hover');
		await page.mouse.move(0, 0);

		await tabTo(page, button);
		expect(parseFloat(await style(button, 'outline-width'))).toBeGreaterThanOrEqual(2);
		expect(await style(button, 'outline-style')).not.toBe('none');
		await captureScreen(page, testInfo, 'workout-set-focus');
	});
});
