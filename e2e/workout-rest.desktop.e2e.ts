/**
 * The rest timer in a desktop window (1440 × 900): docked at the top of the main column under
 * the header, covering nothing, first in the main column's tab order; every control of the timer
 * and of the header's stopwatch has hover and focus-visible states.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { boxOf, expectNoSideScroll } from './desktop';
import { captureScreen } from './support';
import { gotoWorkout, seedWorkout, workoutDay } from './workout-support';

const pill = (page: Page) => page.getByTestId('rest-timer');
const logger = (page: Page) => page.getByTestId('set-logger');
const heading = (page: Page) =>
	page.getByTestId('workout-main').getByTestId('exercise').getByRole('heading', { level: 2 });

/** Opens the leg press and completes its first set, which starts its 2:00. */
async function resting(page: Page) {
	const { strength } = await workoutDay();
	await seedWorkout(page, strength);
	await gotoWorkout(page);
	await expect(page.locator('main#main[data-store]')).toBeAttached();
	await page.getByTestId('workout-side').getByRole('button').nth(1).click();
	await expect(heading(page)).toHaveText('Leg press');
	const load = logger(page).getByTestId('logger-load').getByRole('spinbutton');
	await load.click();
	await load.fill('120');
	await load.press('Enter');
	await logger(page).getByTestId('complete-set').click();
	await expect(pill(page)).toHaveAttribute('data-phase', 'running');
}

const style = (target: Locator, property: string) =>
	target.evaluate((el, property) => getComputedStyle(el).getPropertyValue(property), property);

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
	a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test.describe('the rest timer on a desktop', () => {
	// gotoWorkout holds /api/workouts/* with page.route, which WebKit applies only without a worker.
	test.use({ serviceWorkers: 'block' });

	test('docks at the top of the main column under the header, over nothing', async ({
		page
	}, testInfo) => {
		await resting(page);
		const rest = await boxOf(pill(page));
		const header = await boxOf(page.getByTestId('workout-header'));
		const main = await boxOf(page.getByTestId('workout-main'));
		const card = await boxOf(page.getByTestId('workout-main').getByTestId('exercise'));
		expect(rest.y).toBeGreaterThanOrEqual(header.y + header.height);
		expect(Math.abs(rest.y - main.y), 'first in the main column').toBeLessThanOrEqual(1);
		expect(Math.abs(rest.width - main.width), 'as wide as the column').toBeLessThanOrEqual(1);
		expect(rest.y + rest.height).toBeLessThanOrEqual(card.y);
		for (const [name, other] of [
			['the logger', logger(page)],
			['the list', page.getByTestId('workout-side')],
			['the card', page.getByTestId('workout-main').getByTestId('exercise')]
		] as const) {
			expect(overlaps(rest, await boxOf(other)), `the timer covers ${name}`).toBe(false);
		}
		// Static: scrolled, it stays in the column and still covers nothing.
		await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
		expect(overlaps(await boxOf(pill(page)), await boxOf(logger(page)))).toBe(false);
		await page.evaluate(() => scrollTo(0, 0));
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'workout-rest');
	});

	test('every control of the timer and the stopwatch has hover and focus-visible states, in tab order', async ({
		page
	}) => {
		await resting(page);
		const controls = [
			pill(page).getByRole('button', { name: 'Pause rest' }),
			pill(page).getByRole('button', { name: 'Reset rest' }),
			pill(page).getByRole('button', { name: '+30 s' }),
			pill(page).getByRole('button', { name: 'Skip' }),
			page.getByRole('button', { name: 'Pause workout time' })
		];
		await page.mouse.move(0, 0);
		for (const [i, target] of controls.entries()) {
			await target.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
			const rest = await style(target, 'background-color');
			await target.hover();
			await expect
				.poll(() => style(target, 'background-color'), `control ${i} on hover`)
				.not.toBe(rest);
			await page.mouse.move(0, 0);
			await expect.poll(() => style(target, 'background-color'), `control ${i} at rest`).toBe(rest);
		}

		// By keyboard: the side list's one stop, then the timer's controls, first in the main column.
		await page.locator('main#main').focus();
		for (let i = 0; i < 20; i += 1) {
			if (await controls[0]!.evaluate((el) => el === document.activeElement)) break;
			await page.keyboard.press('Tab');
		}
		await page.keyboard.press('Shift+Tab');
		await expect(
			page.getByTestId('workout-side').getByRole('button', { name: /Leg press/ })
		).toBeFocused();
		await page.keyboard.press('Tab');
		for (const target of controls.slice(0, 4)) {
			await expect(target).toBeFocused();
			await expect.poll(() => style(target, 'outline-style')).toBe('solid');
			await page.keyboard.press('Tab');
		}
		await expect(pill(page).locator(':focus')).toHaveCount(0);
		await expect(page.getByTestId('workout-main').locator(':focus')).toHaveCount(1);

		// Pause by Enter keeps the focus on the same button, now Resume; Skip hands it to logging.
		await controls[0]!.focus();
		await page.keyboard.press('Enter');
		const resume = pill(page).getByRole('button', { name: 'Resume rest' });
		await expect(resume).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await page.keyboard.press('Tab');
		await expect.poll(() => style(resume, 'outline-style')).toBe('solid');
		await controls[3]!.focus();
		await page.keyboard.press('Shift+Tab');
		await page.keyboard.press('Tab');
		await page.keyboard.press('Enter');
		await expect(pill(page)).toHaveCount(0);
		await expect(logger(page).getByTestId('complete-set')).toBeFocused();

		const stopwatch = page.getByRole('button', { name: 'Pause workout time' });
		await stopwatch.focus();
		await page.keyboard.press('Enter');
		const resumeTime = page.getByRole('button', { name: 'Resume workout time' });
		await expect(resumeTime).toBeFocused();
		await page.keyboard.press('Tab');
		const reset = page.getByRole('button', { name: 'Reset workout time' });
		await expect(reset).toBeFocused();
		await expect.poll(() => style(reset, 'outline-style')).toBe('solid');
	});
});
