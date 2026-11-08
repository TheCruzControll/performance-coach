/**
 * The chart kit on /design → Charts in a desktop window (1440 × 900): the section keeps the left
 * column of the gallery, about a phone column wide, so no chart stretches; the marks keep their
 * pixel sizes; 'Show as table' and the table take a visible focus ring from the keyboard and Enter
 * opens the table; the table toggle and each week's hit area take a hover tint for the mouse.
 * Screenshots in both themes.
 */
import { expect, test, type Page } from '@playwright/test';
import {
	auditCharts,
	chartsSection,
	expectMarkSizes,
	fixtureBody,
	fixtureFrame,
	openCharts
} from './charts';
import { boxOf, DESKTOP, expectNoSideScroll, tokenPx } from './desktop';
import { captureScreen, gotoHydrated, trackConsoleErrors } from './support';

test.use(DESKTOP);

const background = (page: Page, selector: string) =>
	page
		.locator(selector)
		.first()
		.evaluate((el) => getComputedStyle(el).backgroundColor);

test.describe('/design → Charts on a desktop', () => {
	for (const theme of ['dark', 'light'] as const) {
		test(`the charts keep a readable column and their pixel sizes (${theme})`, async ({
			page
		}, testInfo) => {
			const errors = trackConsoleErrors(page);
			await page.addInitScript(
				(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
				theme
			);
			await gotoHydrated(page, '/design');
			await openCharts(page);
			if (theme === 'light')
				await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
			await expectMarkSizes(page);
			const section = await boxOf(chartsSection(page));
			const color = await boxOf(page.getByRole('heading', { level: 2, name: 'Color' }));
			expect(Math.abs(section.x - color.x), 'in the left column').toBeLessThanOrEqual(1);
			expect(section.width, 'never wider than the readable column').toBeLessThanOrEqual(
				await tokenPx(page, '--content-readable')
			);
			expect(section.width, 'about a phone column').toBeGreaterThanOrEqual(
				(await tokenPx(page, '--content-max')) - 40
			);
			expect(await auditCharts(page)).toEqual([]);
			await fixtureFrame(page).scrollIntoViewIfNeeded();
			await expectNoSideScroll(page);
			await captureScreen(page, testInfo, `design-charts-${theme}-desktop`);
			expect(errors).toEqual([]);
		});
	}

	test('Show as table and the table take a ring from the keyboard; Enter opens it', async ({
		page
	}, testInfo) => {
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expect(fixtureBody(page)).toBeVisible();
		const summary = fixtureFrame(page).locator('summary');
		await summary.focus();
		const ring = () =>
			page.evaluate(() => {
				const style = getComputedStyle(document.activeElement!);
				return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
			});
		await page.keyboard.press('Shift+Tab');
		await page.keyboard.press('Tab');
		await expect(summary).toBeFocused();
		expect((await ring()).style).not.toBe('none');
		expect((await ring()).width).toBeGreaterThanOrEqual(2);
		await page.keyboard.press('Enter');
		await expect(fixtureFrame(page).locator('details')).toHaveAttribute('open', '');
		await page.keyboard.press('Tab');
		const region = fixtureFrame(page).getByRole('region', { name: 'Hard sets a week, table' });
		await expect(region).toBeFocused();
		expect((await ring()).width).toBeGreaterThanOrEqual(2);
		await fixtureFrame(page).scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, 'design-charts-table-desktop');
	});

	test('the table toggle and a week’s hit area take a hover tint', async ({ page }) => {
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expect(fixtureBody(page)).toBeVisible();
		const summary = fixtureFrame(page).locator('summary');
		await summary.scrollIntoViewIfNeeded();
		const before = await summary.evaluate((el) => getComputedStyle(el).backgroundColor);
		await summary.hover();
		await expect
			.poll(() => summary.evaluate((el) => getComputedStyle(el).backgroundColor))
			.not.toBe(before);
		expect(await summary.evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');

		const hit = '[data-testid="chart-fixture-body"] .pc-hit';
		const rest = await background(page, hit);
		await page.locator(hit).first().hover();
		await expect.poll(() => background(page, hit)).not.toBe(rest);
	});
});
