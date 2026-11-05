import { expect, test } from '@playwright/test';
import { captureScreen, TABS, trackConsoleErrors } from './support';

test.describe('app shell on an iPhone viewport', () => {
	test('landing page renders and leads into the app', async ({ page }, testInfo) => {
		const errors = trackConsoleErrors(page);
		await page.goto('/');
		await expect(page.getByRole('heading', { level: 1, name: /train with intent/i })).toBeVisible();
		await captureScreen(page, testInfo, 'landing');

		await page.getByTestId('passkey-signin').click();
		await expect(page.getByRole('status')).toContainText(/passkey sign-in is coming soon/i);

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

		// Glass actually blurs: guards against the build pipeline dropping the standard
		// `backdrop-filter` (Chromium and Firefox ignore the -webkit- form).
		const glass = await nav.evaluate((el) => {
			const style = getComputedStyle(el) as CSSStyleDeclaration & { webkitBackdropFilter?: string };
			return style.backdropFilter || style.webkitBackdropFilter || 'none';
		});
		expect(glass).toContain('blur(');
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

	test('the theme preference applies before first paint and persists', async ({ page }) => {
		const errors = trackConsoleErrors(page);
		await page.goto('/profile');
		const canvas = () =>
			page.evaluate(() => getComputedStyle(document.body).backgroundColor.replace(/\s/g, ''));
		expect(await canvas()).toBe('rgb(10,10,11)'); // dark by default

		await page.getByTestId('theme-control').getByRole('radio', { name: 'Light' }).click();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

		// After a reload the inline script (allowed by its CSP hash) applies it before paint.
		await page.reload();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		expect(await canvas()).toBe('rgb(244,244,240)');
		await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#f4f4f0');
		await expect(
			page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')
		).toHaveAttribute('content', 'default');

		await page.getByTestId('theme-control').getByRole('radio', { name: 'Dark' }).click();
		await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
		await expect(
			page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')
		).toHaveAttribute('content', 'black-translucent');
		expect(errors).toEqual([]);
	});

	test('no screen scrolls sideways', async ({ page }) => {
		for (const path of ['/', ...TABS.map((t) => t.path), '/design', '/offline']) {
			await page.goto(path);
			await page.evaluate(() => document.fonts.ready);
			const { scrollWidth, innerWidth } = await page.evaluate(() => ({
				scrollWidth: document.documentElement.scrollWidth,
				innerWidth: window.innerWidth
			}));
			expect(scrollWidth, `${path} is ${scrollWidth}px wide`).toBeLessThanOrEqual(innerWidth);
			expect(innerWidth, `${path} widened the layout viewport`).toBe(page.viewportSize()!.width);
		}
	});

	test('nothing sits under fixed chrome at rest', async ({ page }) => {
		const viewport = page.viewportSize()!;

		// Landing: both calls to action are above the fold.
		await page.goto('/');
		for (const cta of [
			page.getByRole('button', { name: /sign in with passkey/i }),
			page.getByRole('link', { name: /preview the app/i })
		]) {
			const box = await cta.boundingBox();
			expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
		}

		// Coach: the docked composer does not cover the suggested questions.
		await page.goto('/coach');
		await page.evaluate(() => document.fonts.ready);
		const composer = await page.getByRole('form', { name: 'Message your coach' }).boundingBox();
		for (const prompt of await page.locator('.prompt').all()) {
			const box = await prompt.boundingBox();
			expect(box!.y + box!.height).toBeLessThanOrEqual(composer!.y);
		}
	});

	test('compact segmented controls keep a 44px hit area', async ({ page }) => {
		await page.goto('/profile');
		const options = page.getByTestId('theme-control').getByRole('radio');
		await expect(options).toHaveCount(3);
		for (const option of await options.all()) {
			const box = (await option.boundingBox())!;
			const x = box.x + box.width / 2;
			const mid = box.y + box.height / 2;
			for (const y of [mid - 21, mid + 21]) {
				const hit = await page.evaluate(
					([px, py]) => document.elementFromPoint(px!, py!)?.closest('[role="radio"]')?.textContent,
					[x, y]
				);
				expect(hit?.trim()).toBe((await option.textContent())?.trim());
			}
		}
	});
});
