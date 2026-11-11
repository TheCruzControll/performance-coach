/**
 * /design → Workout in a desktop window (1440 × 900): the section takes its column beside Charts,
 * about a phone column wide and never wider than the readable column, so no workout component
 * stretches; the logger is a card in the column, not stuck to the window; nothing scrolls sideways
 * at any desktop width; every control answers the mouse with a hover state and the keyboard with
 * a visible ring, each screenshotted, in both themes.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openWorkoutPanel, pick } from './design-workout';
import { boxOf, DESKTOP, DESKTOP_WIDTHS, expectNoSideScroll, tokenPx } from './desktop';
import { captureScreen, trackConsoleErrors } from './support';

test.use(DESKTOP);

/** What a hover or a focus can change: the colours, borders and shadows of a control and inside it. */
const looks = (target: Locator) =>
	target.evaluate((el) =>
		[el, ...el.querySelectorAll('*')]
			.map((node) => {
				const s = getComputedStyle(node);
				return [s.backgroundColor, s.borderColor, s.color, s.boxShadow].join(' ');
			})
			.join('|')
	);

/** Does the focused element, or the face it draws its ring on, show a ring of at least 2 px? */
const focusRing = (page: Page) =>
	page.evaluate(() => {
		const el = document.activeElement as HTMLElement;
		const ringed = (node: Element | null) => {
			if (!node) return false;
			const s = getComputedStyle(node);
			return (
				(s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2) || s.boxShadow !== 'none'
			);
		};
		// A native radio draws its ring on the face beside it; a pill button inside the button.
		const faces = el.tagName === 'INPUT' ? [el.nextElementSibling] : [...el.querySelectorAll('*')];
		return {
			name:
				el.getAttribute('aria-label') ??
				(el.tagName === 'INPUT' ? el.closest('label')?.textContent : el.textContent)?.trim() ??
				el.tagName,
			inPanel: Boolean(el.closest('[data-testid="workout-panel"]')),
			ring: ringed(el) || faces.some(ringed)
		};
	});

test.describe('/design → Workout on a desktop', () => {
	for (const theme of ['dark', 'light'] as const) {
		test(`the states keep a readable column beside Charts (${theme})`, async ({ page }) => {
			const errors = trackConsoleErrors(page);
			await page.addInitScript(
				(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
				theme
			);
			const panel = await openWorkoutPanel(page);
			const box = await boxOf(panel);
			expect(box.width, 'about a phone column').toBeGreaterThanOrEqual(
				(await tokenPx(page, '--content-max')) - 40
			);
			expect(box.width, 'never wider than the readable column').toBeLessThanOrEqual(
				await tokenPx(page, '--content-readable')
			);
			const charts = await boxOf(page.getByRole('heading', { name: 'Charts', exact: true }));
			expect(box.x, 'beside Charts').toBeGreaterThan(charts.x + charts.width);

			// The logger is a card in the column, not full-bleed and not stuck to the window.
			const logger = page.getByTestId('set-logger');
			expect(await logger.evaluate((el) => getComputedStyle(el).position)).toBe('static');
			const card = await boxOf(logger);
			expect(card.x).toBeGreaterThanOrEqual(box.x - 1);
			expect(card.x + card.width).toBeLessThanOrEqual(box.x + box.width + 1);

			await captureScreen(page, test.info(), `design-workout-${theme}`);
			for (const width of DESKTOP_WIDTHS) {
				await page.setViewportSize({ width, height: 900 });
				await expectNoSideScroll(page);
			}
			expect(errors).toEqual([]);
		});
	}

	test('every control takes a hover state for the mouse', async ({ page }) => {
		const panel = await openWorkoutPanel(page);
		const targets: [string, Locator][] = [
			['set-row', panel.getByTestId('set-rows').getByRole('button', { name: /^Edit set\s1\b/ })],
			['plates', panel.getByRole('button', { name: 'Plates for set 4' })],
			['choice', panel.getByTestId('logger-kind').locator('label').nth(1)],
			['rpe', panel.getByTestId('rpe-chips').locator('label').first()],
			['complete', panel.getByTestId('complete-set')],
			['rest', panel.getByTestId('rest-running').getByRole('button').first()],
			['sync', panel.getByTestId('sync-pills').getByRole('button').first()],
			['history', panel.getByTestId('exercise-history-open')]
		];
		for (const [name, target] of targets) {
			await target.scrollIntoViewIfNeeded();
			await page.mouse.move(0, 0);
			const before = await looks(target);
			await target.hover();
			await expect
				.poll(() => looks(target), { message: `${name} changes on hover` })
				.not.toBe(before);
			await captureScreen(page, test.info(), `design-workout-hover-${name}`);
		}
	});

	test('Tab reaches every control in order, each with a visible ring', async ({ page }) => {
		const panel = await openWorkoutPanel(page);
		await pick(panel, 'up-next-kind', 'Between exercises');
		// From the section's toggle, into the panel by the keyboard alone.
		await page.getByTestId('toggle-workout').focus();
		const seen: string[] = [];
		for (let i = 0; i < 120; i++) {
			await page.keyboard.press('Tab');
			const focused = await focusRing(page);
			if (!focused.inPanel) break;
			expect(focused.ring, `${focused.name} shows a ring`).toBe(true);
			seen.push(focused.name);
			if (seen.length === 1) await captureScreen(page, test.info(), 'design-workout-focus');
		}
		// The set rows, the logger, the timers, the pills, Up next and the card, in reading order.
		const order = [
			/^Edit set\s1/,
			/^Barbell/,
			/Increase Weight/,
			/Complete set/,
			/Pause/,
			/attention/,
			/Start Pull-up/,
			/Back squat/,
			/Exercise history/
		].map((name) => seen.findIndex((s) => name.test(s)));
		for (const index of order) expect(index, seen.join(' → ')).toBeGreaterThanOrEqual(0);
		expect(order, 'in reading order').toEqual([...order].sort((a, b) => a - b));
	});
});
