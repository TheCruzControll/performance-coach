/**
 * Moving between exercises in a desktop window (1440 × 900): the side list is one tab stop whose
 * arrows move the focus and whose Enter makes an exercise current, focus staying put; Previous and
 * Next work by Tab and Enter; every list row and both buttons have hover and focus states; a mouse
 * drag moves the card with the pointer; Previous and Next slide to their place under a card of
 * another height, never jumping.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoSideScroll } from './desktop';
import { captureScreen } from './support';
import {
	gotoWorkout,
	readOutbox,
	seedWorkout,
	watchMove,
	workoutDay,
	type WatchedMove
} from './workout-support';

async function open(page: Page) {
	const { strength } = await workoutDay();
	await seedWorkout(page, strength);
	await gotoWorkout(page);
	await expect(page.locator('main#main[data-store]')).toBeAttached();
	await expect(page.getByTestId('up-next')).toBeVisible();
	await expect(next(page)).toBeEnabled();
}

const side = (page: Page) => page.getByTestId('workout-side');
/** The list's exercise rows; Add exercise sits under them. */
const rows = (page: Page) => side(page).getByRole('listitem').getByRole('button');
const addExercise = (page: Page) => side(page).getByTestId('side-add-exercise');
const heading = (page: Page) =>
	page.getByTestId('workout-main').getByTestId('exercise').getByRole('heading', { level: 2 });
const prev = (page: Page) => page.getByTestId('exercise-prev');
const next = (page: Page) => page.getByTestId('exercise-next');
/** The card's name, which opens its history: the main column's first stop. */
const historyOpen = (page: Page) => page.getByTestId('exercise-history-open');
/** The card's quick actions, the next. */
const options = (page: Page) => page.getByTestId('exercise-actions');

const style = (target: Locator, property: string) =>
	target.evaluate((el, property) => getComputedStyle(el).getPropertyValue(property), property);

/** Tabs through the card's plate buttons, one per set of a loaded exercise, each in turn. */
async function tabPastPlates(page: Page) {
	const plates = page.getByTestId('workout-main').getByTestId('set-plates');
	for (const button of await plates.all()) {
		await page.keyboard.press('Tab');
		await expect(button).toBeFocused();
	}
}

/** Tabs from the page's start until `target` has focus, as a keyboard user gets there. */
async function tabTo(page: Page, target: Locator) {
	await page.locator('main#main').focus();
	for (let i = 0; i < 20; i += 1) {
		if (await target.evaluate((el) => el === document.activeElement)) return;
		await page.keyboard.press('Tab');
	}
	await expect(target).toBeFocused();
}

test.describe('moving between exercises on a desktop', () => {
	// gotoWorkout holds /api/workouts/* with page.route, which WebKit applies only without a worker.
	test.use({ serviceWorkers: 'block' });

	test('the side list is one tab stop: the arrows move the focus, Enter makes an exercise current and keeps the focus', async ({
		page
	}) => {
		await open(page);
		await expect(rows(page).and(page.locator('[tabindex="0"]'))).toHaveCount(1);
		await tabTo(page, rows(page).first());
		await expect(rows(page).first()).toHaveAttribute('aria-current', 'step');

		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowDown');
		await expect(rows(page).nth(2)).toBeFocused();
		// The arrows only move the focus.
		await expect(heading(page)).toHaveText('Back squat');
		await page.keyboard.press('Enter');
		await expect(heading(page)).toHaveText('Romanian deadlift');
		await expect(rows(page).nth(2)).toHaveAttribute('aria-current', 'step');
		await expect(rows(page).nth(2)).toBeFocused();

		await page.keyboard.press('End');
		await expect(rows(page).nth(4)).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(rows(page).nth(4)).toBeFocused();
		await page.keyboard.press('Home');
		await expect(rows(page).first()).toBeFocused();
		await page.keyboard.press('ArrowUp');
		await expect(rows(page).first()).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(heading(page)).toHaveText('Back squat');
		await expect(rows(page).first()).toBeFocused();

		// Tab leaves the list from its one stop, for Add exercise under it, then the main column: the
		// card's name (its history), its Options, its set rows' plate buttons, then Next.
		await page.keyboard.press('Tab');
		await expect(addExercise(page)).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(historyOpen(page)).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(options(page)).toBeFocused();
		await tabPastPlates(page);
		await page.keyboard.press('Tab');
		await expect(next(page)).toBeFocused();
		expect((await readOutbox(page)).map((entry) => entry.envelope.type)).toEqual(['workout.start']);
	});

	test('Previous and Next by Tab and Enter; at an end the focus moves to the other', async ({
		page
	}) => {
		await open(page);
		await tabTo(page, next(page));
		for (const name of ['Leg press', 'Romanian deadlift', 'Pull-up']) {
			await page.keyboard.press('Enter');
			await expect(heading(page)).toHaveText(name);
			await expect(next(page)).toBeFocused();
		}
		await page.keyboard.press('Enter');
		await expect(heading(page)).toHaveText('Plank');
		await expect(next(page)).toBeDisabled();
		await expect(prev(page)).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(heading(page)).toHaveText('Pull-up');
		await expect(prev(page)).toBeFocused();
		await expect(side(page).locator('[aria-current="step"]')).toHaveText(/^A1\s*Pull-up/);
	});

	test('a mouse drag across the wide card follows the pointer, moves on, and never widens the page', async ({
		page
	}) => {
		await open(page);
		const card = page.getByTestId('workout-main').getByTestId('exercise');
		const box = (await heading(page).boundingBox())!;
		const x = box.x + box.width / 2;
		const y = box.y + box.height / 2;
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.mouse.move(x - 260, y, { steps: 8 });
		expect(
			await card.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41)
		).toBeCloseTo(-260, 0);
		await expectNoSideScroll(page);
		await page.mouse.up();
		await expect(heading(page)).toHaveText('Leg press');
		await expect(rows(page).nth(1)).toHaveAttribute('aria-current', 'step');
		await expectNoSideScroll(page);
		await expect
			.poll(() => card.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41))
			.toBe(0);
	});

	test('under a taller or shorter card, Previous and Next slide to their place, never jumping', async ({
		page
	}) => {
		await open(page);
		const moves: WatchedMove[] = [];
		while (await next(page).isEnabled()) {
			const move = await watchMove(page, 'exercise-next');
			expect(Math.abs(move.first - move.before), JSON.stringify(move)).toBeLessThanOrEqual(1);
			moves.push(move);
		}
		const moved = moves.filter((move) => Math.abs(move.after - move.before) > 1);
		expect(moved.length, 'the fixture has cards of different heights').toBeGreaterThan(0);
		for (const move of moved) expect(move.sliding, JSON.stringify(move)).toBe(1);
	});

	test('every list row and both buttons have hover and focus-visible states', async ({ page }) => {
		await open(page);
		await next(page).click();
		await expect(heading(page)).toHaveText('Leg press');
		const targets = [...(await rows(page).all()), addExercise(page), prev(page), next(page)];
		await page.mouse.move(0, 0);
		for (const [i, target] of targets.entries()) {
			// Once its transitions have run (the row that was current is still fading).
			await target.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
			const rest = await style(target, 'background-color');
			await target.hover();
			await expect
				.poll(() => style(target, 'background-color'), `target ${i} on hover`)
				.not.toBe(rest);
			await page.mouse.move(0, 0);
			await expect.poll(() => style(target, 'background-color'), `target ${i} at rest`).toBe(rest);
		}
		// Focus by keyboard: each row and button draws its ring.
		await tabTo(page, rows(page).nth(1));
		for (let i = 0; i < 5; i += 1) {
			const row = rows(page).nth(i);
			await page.keyboard.press(i === 0 ? 'Home' : 'ArrowDown');
			await expect(row).toBeFocused();
			await expect.poll(() => style(row, 'outline-style')).toBe('solid');
		}
		await page.keyboard.press('Tab');
		await expect(addExercise(page)).toBeFocused();
		await expect.poll(() => style(addExercise(page), 'outline-style')).toBe('solid');
		await page.keyboard.press('Tab');
		await expect(historyOpen(page)).toBeFocused();
		await expect.poll(() => style(historyOpen(page), 'outline-style')).toBe('solid');
		await page.keyboard.press('Tab');
		await expect(options(page)).toBeFocused();
		await tabPastPlates(page);
		await page.keyboard.press('Tab');
		await expect(prev(page)).toBeFocused();
		await expect.poll(() => style(prev(page), 'outline-style')).toBe('solid');
		await page.keyboard.press('Tab');
		await expect(next(page)).toBeFocused();
		await expect.poll(() => style(next(page), 'outline-style')).toBe('solid');
	});

	test('between exercises, at 1440 × 900', async ({ page }, testInfo) => {
		await open(page);
		await rows(page).nth(1).click();
		await expect(heading(page)).toHaveText('Leg press');
		const logger = page.getByTestId('set-logger');
		const load = logger.getByTestId('logger-load').getByRole('spinbutton');
		await load.click();
		await load.fill('120');
		await load.press('Enter');
		for (let set = 1; set <= 3; set += 1) {
			await expect(logger).toContainText(`Set ${set} of 3`);
			await logger.getByTestId('complete-set').click();
		}
		await expect(page.getByTestId('up-next')).toHaveAttribute('data-between', '');
		await expect(rows(page).nth(1)).toContainText('3/3 sets');
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'workout-between-exercises');
		const start = page.getByRole('button', { name: 'Start Romanian deadlift' });
		await start.hover();
		await start.click();
		await expect(heading(page)).toHaveText('Romanian deadlift');
		await expect(rows(page).nth(2)).toHaveAttribute('aria-current', 'step');
	});
});
