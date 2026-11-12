/**
 * Graphite 2004's shell in a desktop window (1440 × 900): from 1024 px the rail becomes the source
 * list, wider and with each destination a row of icon and label, the current one in the selection
 * well, with hover and keyboard focus states, and the content still centred beside it at a readable
 * width. Today's design keeps its icon rail. The phone window is design-shell.e2e.ts.
 */
import { expect, test, type Page } from '@playwright/test';
import { boxOf, expectMainCentred, expectNoSideScroll, tokenPx } from './desktop';
import { gotoHydrated } from './support';

const DESIGN_KEY = 'pc:design:v1';

const choose = (page: Page, design: 'current' | 'graphite') =>
	page.addInitScript(([key, d]) => localStorage.setItem(key!, d!), [DESIGN_KEY, design]);

const list = (page: Page) => page.getByRole('navigation', { name: 'Primary' });

test('today’s design keeps the icon rail', async ({ page }) => {
	await choose(page, 'current');
	await gotoHydrated(page, '/today');
	await expect(page.locator('html')).not.toHaveAttribute('data-design', /.*/);
	expect((await boxOf(list(page))).width).toBeCloseTo(await tokenPx(page, '--rail-width'), 0);
	expect(await tokenPx(page, '--rail-width')).toBe(88);
	const today = list(page).getByRole('link', { name: 'Today' });
	// Icon over label.
	const icon = await boxOf(today.locator('svg'));
	const label = await boxOf(today.getByText('Today', { exact: true }));
	expect(label.y).toBeGreaterThan(icon.y + icon.height - 1);
});

test('Graphite’s source list: rows of icon and label, the current one in the well', async ({
	page
}) => {
	await choose(page, 'graphite');
	await gotoHydrated(page, '/today');
	await expect(page.locator('html')).toHaveAttribute('data-design', 'graphite');
	await page.waitForFunction(() => document.fonts.status === 'loaded');

	const nav = list(page);
	expect(await tokenPx(page, '--rail-width')).toBe(232);
	const box = await boxOf(nav);
	expect(box.width).toBeCloseTo(232, 0);
	expect(box.height).toBeCloseTo(900, 0);

	const items = nav.getByRole('link');
	await expect(items).toHaveCount(5);
	for (const item of await items.all()) {
		const row = await boxOf(item);
		const icon = await boxOf(item.locator('svg'));
		const label = await boxOf(item.locator('.label'));
		// Side by side, on one line, across the list.
		expect(label.x, (await item.textContent()) ?? '').toBeGreaterThan(icon.x + icon.width);
		expect(Math.abs(label.y + label.height / 2 - (icon.y + icon.height / 2))).toBeLessThan(3);
		expect(row.height).toBeGreaterThanOrEqual(44);
		expect(row.width).toBeGreaterThan(200);
	}
	const current = nav.getByRole('link', { name: 'Today' });
	await expect(current).toHaveAttribute('aria-current', 'page');
	expect(await current.evaluate((a) => getComputedStyle(a).backgroundImage)).toContain(
		'linear-gradient'
	);

	// The content beside it, centred in what is left, never under it.
	await expectMainCentred(page);
	expect((await boxOf(page.locator('main#main'))).x).toBeGreaterThanOrEqual(box.x + box.width);
	await expectNoSideScroll(page);
});

test('Graphite’s source list answers the pointer and the keyboard', async ({ page }) => {
	await choose(page, 'graphite');
	await gotoHydrated(page, '/today');
	await expect(page.locator('html')).toHaveAttribute('data-design', 'graphite');
	const train = list(page).getByRole('link', { name: 'Train' });
	const background = () => train.evaluate((a) => getComputedStyle(a).backgroundColor);
	const resting = await background();
	await train.hover();
	await expect.poll(background).not.toBe(resting);

	await page.mouse.move(1000, 600);
	await train.focus();
	await page.keyboard.press('Shift+Tab');
	await page.keyboard.press('Tab');
	await expect(train).toBeFocused();
	const ring = await train.evaluate((a) => {
		const style = getComputedStyle(a);
		return { style: style.outlineStyle, width: style.outlineWidth };
	});
	expect(ring).toEqual({ style: 'solid', width: '2px' });

	await page.keyboard.press('Enter');
	await expect(page).toHaveURL('/train');
	await expect(train).toHaveAttribute('aria-current', 'page');
});
