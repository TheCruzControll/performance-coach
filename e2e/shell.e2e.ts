import { expect, test } from '@playwright/test';
import { captureScreen, TABS, trackConsoleErrors } from './support';

test.describe('app shell on an iPhone viewport', () => {
	test('landing page renders and leads into the app', async ({ page }, testInfo) => {
		const errors = trackConsoleErrors(page);
		await page.goto('/');
		await expect(page.getByRole('heading', { level: 1, name: /train with intent/i })).toBeVisible();
		await captureScreen(page, testInfo, 'landing');

		await page.getByTestId('passkey-signin').click();
		await expect(page.getByRole('status')).toContainText(/passkey sign-in arrives/i);

		await page.getByRole('link', { name: /preview the app/i }).click();
		await expect(page).toHaveURL(/\/today$/);
		await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
		expect(errors).toEqual([]);
	});

	test('shell renders with the bottom navigation inside the safe viewport', async ({
		page
	}, testInfo) => {
		await page.goto('/today');
		const viewport = page.viewportSize();
		expect(viewport?.width).toBeLessThanOrEqual(430);

		const nav = page.getByRole('navigation', { name: 'Primary' });
		await expect(nav).toBeVisible();
		await expect(nav.getByRole('link')).toHaveCount(TABS.length);
		await expect(nav.getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'page');

		// Pinned to the bottom edge, full width, every target at least 44px tall.
		const box = await nav.boundingBox();
		expect(box).not.toBeNull();
		expect(Math.round(box!.y + box!.height)).toBe(viewport!.height);
		expect(Math.round(box!.width)).toBe(viewport!.width);
		for (const link of await nav.getByRole('link').all()) {
			const b = await link.boundingBox();
			expect(b!.height).toBeGreaterThanOrEqual(44);
		}
		await captureScreen(page, testInfo, 'today');
	});

	test('bottom navigation moves between all tabs', async ({ page }, testInfo) => {
		const errors = trackConsoleErrors(page);
		await page.goto('/today');
		const nav = page.getByRole('navigation', { name: 'Primary' });

		for (const tab of [...TABS.slice(1), TABS[0]]) {
			await nav.getByRole('link', { name: tab.label }).click();
			await expect(page).toHaveURL(new RegExp(`${tab.path}$`));
			await expect(page.getByRole('heading', { level: 1, name: tab.heading })).toBeVisible();
			await expect(nav.getByRole('link', { name: tab.label })).toHaveAttribute(
				'aria-current',
				'page'
			);
			await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
			if (tab.path !== '/today') await captureScreen(page, testInfo, tab.path.slice(1));
		}
		expect(errors).toEqual([]);
	});

	test('no console errors on any screen, including interactive ones', async ({ page }) => {
		const errors = trackConsoleErrors(page);
		for (const path of ['/', ...TABS.map((t) => t.path), '/design', '/offline']) {
			await page.goto(path);
			await page.waitForLoadState('networkidle');
		}
		await page.goto('/train');
		await page.getByTestId('open-plates').click();
		await expect(page.getByTestId('plates-sheet')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('plates-sheet')).toBeHidden();
		expect(errors).toEqual([]);
	});

	test('plate calculator sheet: stepper, unit switch, focus return', async ({ page }, testInfo) => {
		await page.goto('/train');
		const opener = page.getByTestId('open-plates');
		await opener.click();

		const sheet = page.getByRole('dialog', { name: 'Plate calculator' });
		await expect(sheet).toBeVisible();
		await expect(sheet.getByTestId('plates-result')).toContainText('25 · 15');

		await sheet.getByRole('button', { name: 'Increase Target weight' }).click();
		await expect(sheet.getByRole('spinbutton', { name: 'Target weight' })).toHaveAttribute(
			'aria-valuenow',
			'102.5'
		);
		await expect(sheet.getByTestId('plates-result')).toContainText('25 · 15 · 1.25');
		await captureScreen(page, testInfo, 'plate-calculator');

		await sheet.getByRole('radio', { name: 'Pounds' }).click();
		await expect(sheet.getByRole('spinbutton', { name: 'Target weight' })).toHaveAttribute(
			'aria-valuenow',
			'225'
		);
		await expect(sheet.getByTestId('plates-result')).toContainText('45 · 45');

		await sheet.getByRole('button', { name: 'Close' }).click();
		await expect(sheet).toBeHidden();
		await expect(opener).toBeFocused();
	});
});
