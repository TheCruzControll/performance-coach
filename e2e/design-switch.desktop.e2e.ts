/**
 * The design switch in a desktop window (1440 × 900): Profile's Design choice works from the
 * keyboard with a visible focus ring, Graphite keeps the shell's centred layout, its font swaps in
 * without moving the page (the metric-matched fallback), and axe passes in both themes.
 */
import { expect, test, type Page } from '@playwright/test';
import { audit } from './a11y-suite';
import { expectMainCentred, expectNoSideScroll, layoutShiftDuring } from './desktop';
import { gotoHydrated } from './support';

const DESIGN_KEY = 'pc:design:v1';

const accent = (page: Page) =>
	page.evaluate(() =>
		getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()
	);

test('the Design choice switches from the keyboard, in the centred layout', async ({ page }) => {
	await gotoHydrated(page, '/profile');
	const control = page.getByRole('radiogroup', { name: 'Design' });
	const current = control.getByRole('radio', { name: 'Current', exact: true });
	const graphite = control.getByRole('radio', { name: 'Graphite 2004', exact: true });
	await expect(current).toBeChecked();

	await current.focus();
	await page.keyboard.press('ArrowRight');
	await expect(graphite).toBeChecked();
	await expect(graphite).toBeFocused();
	await expect(page.locator('html')).toHaveAttribute('data-design', 'graphite');
	await expect.poll(() => accent(page)).toBe('#1a6bd6');
	// A visible focus ring, in Graphite's focus colour.
	const ring = await graphite.evaluate((option) => {
		const style = getComputedStyle(option);
		return { style: style.outlineStyle, color: style.outlineColor };
	});
	expect(ring).toEqual({ style: 'solid', color: 'rgb(108, 176, 255)' });

	await expectMainCentred(page);
	await expectNoSideScroll(page);

	await page.keyboard.press('ArrowLeft');
	await expect(current).toBeChecked();
	await expect(page.locator('html')).not.toHaveAttribute('data-design', /.*/);
	await expect.poll(() => accent(page)).toBe('#c8f031');
});

test.describe('with the network in the test’s hands', () => {
	// page.route never sees a request the service worker answers.
	test.use({ serviceWorkers: 'block' });

	test('Source Sans 3 swaps in over its fallback without shifting the page', async ({ page }) => {
		await page.addInitScript((key) => localStorage.setItem(key, 'graphite'), DESIGN_KEY);
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		await page.route(/\/source-sans-3-latin-wght-normal\.[\w-]+\.woff2$/, async (route) => {
			await held;
			await route.continue();
		});
		await page.goto('/profile');
		await expect(page.getByRole('radiogroup', { name: 'Design' })).toBeVisible();
		await expect.poll(() => accent(page)).toBe('#1a6bd6');

		const shift = await layoutShiftDuring(page, async () => {
			release();
			await page.waitForFunction(() => document.fonts.status === 'loaded');
			await expect
				.poll(() =>
					page.evaluate(() =>
						[...document.fonts].some(
							(face) =>
								face.family.replace(/["']/g, '') === 'Source Sans 3' && face.status === 'loaded'
						)
					)
				)
				.toBe(true);
		});
		expect(shift).toBeLessThanOrEqual(0.01);
	});
});

for (const theme of ['dark', 'light'] as const) {
	test(`Graphite’s Today and Profile have no WCAG A/AA violations (${theme} theme)`, async ({
		page
	}) => {
		await page.addInitScript(
			([t, key]) => {
				localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t }));
				localStorage.setItem(key!, 'graphite');
			},
			[theme, DESIGN_KEY]
		);
		for (const path of ['/today', '/profile']) {
			await gotoHydrated(page, path);
			if (path === '/profile') await expect(page.getByTestId('db-status')).toBeVisible();
			await expect(page.locator('html')).toHaveAttribute('data-design', 'graphite');
			await expect.poll(() => accent(page)).toBe('#1a6bd6');
			await page.waitForFunction(() => document.fonts.status === 'loaded');
			await page.waitForTimeout(400);
			expect(await audit(page), path).toEqual([]);
		}
	});
}
