import { expect, test, type Page } from '@playwright/test';
import { TABS } from './support';

/** Resolves once the service worker controls the page (no reload: it claims clients). */
async function waitForController(page: Page) {
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
		timeout: 15_000
	});
}

test.describe('offline behaviour (service worker)', () => {
	// Playwright emulates offline for service-worker traffic only in Chromium; WebKit's PWA
	// behaviour is covered by the registration test in platform.e2e.ts.
	test.skip(({ browserName }) => browserName !== 'chromium', 'offline emulation is Chromium-only');

	test('the first visit is controlled without a reload', async ({ page }) => {
		await page.goto('/today');
		await waitForController(page);
		expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(1);
	});

	test('offline: every tab keeps the shell; data screens show the offline state', async ({
		page,
		context
	}) => {
		await page.goto('/today');
		await waitForController(page);
		const nav = page.getByRole('navigation', { name: 'Primary' });

		await context.setOffline(true);
		await expect(page.getByTestId('offline-notice')).toBeVisible();

		// Screens without server data render from the precached build.
		for (const tab of TABS.filter((t) => t.path !== '/profile')) {
			await nav.getByRole('link', { name: tab.label }).click();
			await expect(page).toHaveURL(new RegExp(`${tab.path}$`));
			await expect(page.getByRole('heading', { level: 1, name: tab.heading })).toBeVisible();
		}

		// Profile needs server data: a designed offline state inside the shell, never a 500.
		await nav.getByRole('link', { name: 'Profile' }).click();
		await expect(page).toHaveURL(/\/profile$/);
		await expect(page.getByTestId('offline-state')).toBeVisible();
		await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
		await expect(nav.getByRole('link', { name: 'Profile' })).toHaveAttribute(
			'aria-current',
			'page'
		);
		await expect(page).toHaveTitle('Offline · Performance Coach');
		await expect(page.locator('body')).not.toContainText(/500|internal error/i);
		await expect(page.getByTestId('offline-notice')).toHaveCount(0); // no duplicate notice

		// A full page load offline gets the precached offline screen, still in the shell.
		await page.reload();
		await expect(page).toHaveURL(/\/profile$/);
		await expect(page.getByTestId('offline-state')).toBeVisible();
		await expect(nav).toBeVisible();
		await expect(nav.getByRole('link', { name: 'Profile' })).toHaveAttribute(
			'aria-current',
			'page'
		);

		// …from which the tabs that need no server data still work.
		await nav.getByRole('link', { name: 'Train' }).click();
		await expect(page.getByRole('heading', { level: 1, name: 'Train' })).toBeVisible();

		// Back online, the screen loads live data again.
		await nav.getByRole('link', { name: 'Profile' }).click();
		await expect(page.getByTestId('offline-state')).toBeVisible();
		await context.setOffline(false);
		await expect(page.getByTestId('db-status')).toContainText(/connected · \d+ ms/i, {
			timeout: 15_000
		});
	});

	test('server unreachable while the device is online: honest copy, recovers by itself', async ({
		page,
		context
	}) => {
		await page.goto('/today');
		await waitForController(page);

		// The device stays online, but the server stops answering (lie-fi, outage).
		const unreachable = (route: { abort: (code: string) => Promise<void> }) =>
			route.abort('connectionrefused');
		// Context-level routes also cover requests that pass through the service worker.
		await context.route('**/__data.json*', unreachable);
		await context.route('**/api/health', unreachable);

		await page
			.getByRole('navigation', { name: 'Primary' })
			.getByRole('link', { name: 'Profile' })
			.click();
		const state = page.getByTestId('offline-state');
		await expect(state).toBeVisible();
		await expect(state).toContainText("Can't reach the server");
		expect(await page.evaluate(() => navigator.onLine)).toBe(true);

		// The server comes back: with no `online` event to wait for, the screen's own retry
		// (backoff probe of /api/health) brings live data back without a tap.
		await context.unrouteAll({ behavior: 'ignoreErrors' });
		await expect(page.getByTestId('db-status')).toContainText(/connected · \d+ ms/i, {
			timeout: 20_000
		});
	});

	test('dynamic pages are never stored by the service worker', async ({ page, context }) => {
		await page.goto('/profile');
		await waitForController(page);
		for (const path of ['/today', '/profile', '/coach']) await page.goto(path);

		const stored = await page.evaluate(async () => {
			const found: string[] = [];
			for (const key of await caches.keys()) {
				const cache = await caches.open(key);
				for (const request of await cache.keys()) found.push(new URL(request.url).pathname);
			}
			return { keys: await caches.keys(), paths: found };
		});
		expect(stored.keys.every((k) => k.startsWith('pc-shell-'))).toBe(true);
		for (const path of ['/today', '/profile', '/coach', '/train', '/progress', '/']) {
			expect(stored.paths).not.toContain(path);
		}

		// Offline, a page that was visited is not replayed from a cache: the offline screen is.
		await context.setOffline(true);
		await page.goto('/today').catch(() => {});
		await expect(page.getByTestId('offline-state')).toBeVisible();
		await page.goto('/profile').catch(() => {});
		await expect(page.getByTestId('offline-state')).toBeVisible();
		await expect(page.getByTestId('db-status')).toHaveCount(0);
	});
});
