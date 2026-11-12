/**
 * Graphite 2004's screens in a desktop window (1440 × 900; graphite.css, Screens): the logger is a
 * card in the column with no action bar, the composer floats over the column instead of docking,
 * keyboard focus on an RPE key and a view tab shows Graphite's ring drawn inside the connected
 * control, a fine pointer lights a plastic key, and nothing scrolls sideways. Today's design keeps
 * its own hover. The phone is design-screens.e2e.ts.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openWorkoutPanel } from './design-workout';
import { expectNoSideScroll } from './desktop';
import { gotoHydrated } from './support';

const DESIGN_KEY = 'pc:design:v1';

const choose = (page: Page, design: 'current' | 'graphite') =>
	page.addInitScript(([key, d]) => localStorage.setItem(key!, d!), [DESIGN_KEY, design]);

const css = (locator: Locator, property: string) =>
	locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);

async function graphite(page: Page) {
	await expect(page.locator('html')).toHaveAttribute('data-design', 'graphite');
	await page.waitForFunction(() => document.fonts.status === 'loaded');
}

test('Graphite: the logger card, the RPE ring inside the grid, and a lit key', async ({ page }) => {
	await choose(page, 'graphite');
	const panel = await openWorkoutPanel(page);
	await graphite(page);
	expect(page.viewportSize()!.width).toBeGreaterThanOrEqual(1024);

	// No bar from 1024 px: the logger is a card in the column.
	const logger = panel.getByTestId('set-logger').first();
	expect(await css(logger, 'background-image')).toBe('none');
	expect(await css(logger, 'position')).toBe('static');

	const rpe = panel.getByTestId('rpe-chips').first();
	const six = rpe.getByRole('radio', { name: '6', exact: true });
	await six.focus();
	await page.keyboard.press('ArrowRight');
	const focused = rpe.getByRole('radio', { name: '6.5', exact: true });
	await expect(focused).toBeFocused();
	const face = focused.locator('xpath=following-sibling::span[1]');
	// The ring inside the key, so the grid's clipped corners never cut it.
	expect(await css(face, 'outline-style')).toBe('solid');
	expect(await css(face, 'outline-offset')).toBe('-3px');

	// Hover the radio itself: it sits over its face (opacity 0, z-index 1) and takes the pointer.
	const nine = rpe.getByRole('radio', { name: '9', exact: true });
	const otherFace = nine.locator('xpath=following-sibling::span[1]');
	await page.mouse.move(0, 0);
	const before = await css(otherFace, 'box-shadow');
	await nine.hover();
	await expect.poll(() => css(otherFace, 'box-shadow')).not.toBe(before);
	await expectNoSideScroll(page);
});

test('Graphite: Progress’s view tabs take focus and hover inside one control', async ({ page }) => {
	await choose(page, 'graphite');
	await gotoHydrated(page, '/progress');
	await graphite(page);
	const views = page.getByRole('navigation', { name: 'Progress views' });
	const tab = views.getByRole('link').nth(1);
	await views.getByRole('link').first().focus();
	await page.keyboard.press('Tab');
	await expect(tab).toBeFocused();
	expect(await css(tab, 'outline-style')).toBe('solid');
	expect(await css(tab, 'outline-offset')).toBe('-3px');
	await page.mouse.move(0, 0);
	const before = await css(tab, 'background-color');
	await tab.hover();
	await expect.poll(() => css(tab, 'background-color')).not.toBe(before);
	await expectNoSideScroll(page);
});

test('Graphite: the composer floats over the column, not docked to a tab bar', async ({ page }) => {
	await choose(page, 'graphite');
	await gotoHydrated(page, '/coach');
	await graphite(page);
	const composer = page.getByRole('form', { name: 'Message your coach' });
	await expect(composer).toBeVisible();
	const box = (await composer.boundingBox())!;
	const viewport = page.viewportSize()!;
	expect(box.width).toBeLessThan(viewport.width / 2 + 200);
	expect(viewport.height - (box.y + box.height)).toBeGreaterThan(4);
	expect(await css(composer, 'border-top-left-radius')).not.toBe('0px');
	await expectNoSideScroll(page);
});

test('today’s design keeps its own RPE keys and hover', async ({ page }) => {
	await choose(page, 'current');
	const panel = await openWorkoutPanel(page);
	await expect(page.locator('html')).not.toHaveAttribute('data-design', /.*/);
	const face = panel.getByTestId('rpe-chips').first().locator('.face').first();
	expect(await css(face, 'background-image')).toBe('none');
	expect(await css(panel.getByTestId('rpe-chips').first().locator('.chips'), 'row-gap')).not.toBe(
		'1px'
	);
});
