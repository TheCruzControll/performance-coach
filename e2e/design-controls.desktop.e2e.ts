/**
 * Graphite 2004's controls in a desktop window (1440 × 900): a keyboard-focused control shows
 * Graphite's ring (2 px Aqua ink, 2 px out), plastic brightens under a fine pointer while today's
 * design keeps its own hover, and a sheet is still the centred window, on the spring.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { gotoHydrated } from './support';

const DESIGN_KEY = 'pc:design:v1';

const ring = (locator: Locator) =>
	locator.evaluate((el) => {
		const style = getComputedStyle(el);
		return {
			style: style.outlineStyle,
			width: style.outlineWidth,
			offset: style.outlineOffset,
			color: style.outlineColor
		};
	});

const filterOf = (locator: Locator) => locator.evaluate((el) => getComputedStyle(el).filter);

async function openDesign(page: Page, design: 'current' | 'graphite') {
	await gotoHydrated(page, `/design?design=${design}`);
	if (design === 'graphite') {
		await expect(page.locator('html')).toHaveAttribute('data-design', 'graphite');
	} else {
		await expect(page.locator('html')).not.toHaveAttribute('data-design', /.*/);
	}
	await page.waitForFunction(() => document.fonts.status === 'loaded');
	return page.getByRole('tabpanel', { name: 'Buttons' });
}

test('Graphite’s focus ring and hover, and today’s left as they were', async ({ page }) => {
	let panel = await openDesign(page, 'graphite');
	let secondary = panel.getByRole('button', { name: 'Plate calculator' });

	// Keyboard focus: Tab from the button before it lands here with the ring drawn.
	await panel.getByRole('button', { name: 'Start workout' }).focus();
	await page.keyboard.press('Tab');
	await expect(secondary).toBeFocused();
	expect(await ring(secondary)).toEqual({
		style: 'solid',
		width: '2px',
		offset: '2px',
		color: 'rgb(108, 176, 255)'
	});

	await page.mouse.move(0, 0);
	expect(await filterOf(secondary)).toBe('none');
	await secondary.hover();
	await expect.poll(() => filterOf(secondary)).toBe('brightness(1.08)');

	panel = await openDesign(page, 'current');
	secondary = panel.getByRole('button', { name: 'Plate calculator' });
	await panel.getByRole('button', { name: 'Start workout' }).focus();
	await page.keyboard.press('Tab');
	await expect(secondary).toBeFocused();
	// Today's ring: 3 px out, as base.css draws it.
	expect((await ring(secondary)).offset).toBe('3px');
	await secondary.hover();
	expect(await filterOf(secondary)).toBe('none');
});

test('a Graphite sheet is the centred window, on the spring', async ({ page }) => {
	await page.addInitScript((key) => localStorage.setItem(key, 'graphite'), DESIGN_KEY);
	await gotoHydrated(page, '/design');
	await page.getByRole('tab', { name: 'Feedback' }).click();
	await page.getByTestId('open-sheet').click();
	const dialog = page.getByRole('dialog', { name: 'Substitute exercise' });
	await expect(dialog).toBeVisible();
	const sheet = dialog.locator(':scope > .sheet');
	const style = await sheet.evaluate((el) => {
		const s = getComputedStyle(el);
		return { corner: s.borderBottomLeftRadius, easing: s.transitionTimingFunction };
	});
	expect(style.corner).toBe('10px');
	expect(style.easing).toMatch(/^linear\(/);
	const box = (await sheet.boundingBox())!;
	const viewport = page.viewportSize()!;
	expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2);
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
});
