/**
 * The workout screen in a desktop window (1440 × 900): the header spans the page, and the side and
 * main columns sit side by side, centred, with hover and focus states, in reading order.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
	BELOW_DESKTOP_WIDTH,
	boxOf,
	DESKTOP_WIDTHS,
	expectNoSideScroll,
	layoutWidth
} from './desktop';
import { captureScreen } from './support';
import { gotoWorkout, seedWorkout, workoutDay } from './workout-support';

async function openWorkout(page: Page) {
	const kits = await workoutDay();
	await seedWorkout(page, kits.strength);
	await gotoWorkout(page);
	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lower body & pull');
}

const background = (locator: Locator) =>
	locator.evaluate((el) => getComputedStyle(el).backgroundColor);

test.describe('the workout screen on a desktop', () => {
	// gotoWorkout holds /api/workouts/* with page.route, which WebKit applies only without a worker.
	test.use({ serviceWorkers: 'block' });

	test('the side and main columns sit side by side, centred, with no sideways scroll', async ({
		page
	}, testInfo) => {
		await openWorkout(page);
		const side = await boxOf(page.getByTestId('workout-side'));
		const main = await boxOf(page.getByTestId('workout-main'));
		expect(side.x + side.width, 'the side column ends before the main one').toBeLessThan(main.x);
		expect(Math.abs(side.y - main.y), 'both start at the same height').toBeLessThanOrEqual(1);
		const left = side.x;
		const right = (await layoutWidth(page)) - (main.x + main.width);
		expect(Math.abs(left - right), `gaps beside the columns: ${left} and ${right}`).toBeLessThan(2);

		// The header spans the page; its content lines up with the columns.
		const header = await boxOf(page.getByTestId('workout-header'));
		expect(header.width).toBeGreaterThanOrEqual((await layoutWidth(page)) - 1);
		const minimise = await boxOf(page.getByRole('link', { name: 'Minimise' }));
		expect(Math.abs(minimise.x - side.x)).toBeLessThanOrEqual(1);
		await captureScreen(page, testInfo, 'workout-active');

		for (const width of [...DESKTOP_WIDTHS, BELOW_DESKTOP_WIDTH]) {
			await page.setViewportSize({ width, height: 900 });
			await expectNoSideScroll(page);
		}
		// Below 1024 px: one column, the cards alone.
		await expect(page.getByTestId('workout-side')).toBeHidden();
	});

	test('Minimise has hover and focus-visible states', async ({ page }) => {
		await openWorkout(page);
		await page.mouse.move(0, 0);
		const targets = [page.getByRole('link', { name: 'Minimise' })];
		for (const target of targets) {
			const rest = await background(target);
			await target.hover();
			await expect.poll(() => background(target), `${target} on hover`).not.toBe(rest);
			await page.mouse.move(0, 0);
			await expect.poll(() => background(target)).toBe(rest);
			await target.focus();
			await expect(target).toHaveCSS('outline-style', 'solid');
			await target.blur();
		}
	});

	test('Tab reaches every control in reading order', async ({ page }) => {
		await openWorkout(page);
		// The header's More button loads on idle, with the store.
		await expect(page.getByTestId('workout-menu-button')).toBeVisible();
		await page.locator('body').focus();
		const order: string[] = [];
		for (let i = 0; i < 6; i++) {
			await page.keyboard.press('Tab');
			const stop = await page.evaluate(() => {
				const el = document.activeElement;
				if (el?.getAttribute('data-testid') === 'sync-pill') return 'sync-pill';
				const text = (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
				return text || (el?.getAttribute('aria-label') ?? '');
			});
			order.push(stop);
		}
		expect(order[0]).toBe('Skip to content');
		expect(order[1]).toBe('Minimise');
		// The header's sync pill is a stop only while it has something to show (Saving…, say).
		const rest = order.slice(2).filter((stop) => stop !== 'sync-pill');
		// The header's stopwatch and its More button, then the side list: one stop, at the current
		// exercise, before the main column.
		expect(rest.slice(0, 3)).toEqual([
			'Pause workout time',
			'Workout options',
			'1 Back squat 0/4 sets'
		]);
		await expect(page.getByTestId('workout-side').locator('[tabindex="0"]')).toHaveCount(1);
	});
});
