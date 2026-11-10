import { expect, test, type Page } from '@playwright/test';
import { TABS } from './support';

/** Tabs whose screen loads server data, so offline they show the designed offline state. */
const DATA_SCREENS: string[] = ['/today', '/train', '/progress', '/profile'];

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
		for (const tab of TABS.filter((t) => !DATA_SCREENS.includes(t.path))) {
			await nav.getByRole('link', { name: tab.label }).click();
			await expect(page).toHaveURL(new RegExp(`${tab.path}$`));
			await expect(page.getByRole('heading', { level: 1, name: tab.heading })).toBeVisible();
		}

		// Today needs server data (the setup card): the designed offline state in the shell.
		await nav.getByRole('link', { name: 'Today' }).click();
		await expect(page).toHaveURL(/\/today$/);
		await expect(page.getByTestId('offline-state')).toBeVisible();
		await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
		await expect(page.locator('body')).not.toContainText(/500|internal error/i);

		// Train needs server data (the program's week): the designed offline state in the shell.
		await nav.getByRole('link', { name: 'Train' }).click();
		await expect(page).toHaveURL(/\/train$/);
		await expect(page.getByTestId('offline-state')).toBeVisible();
		await expect(page.getByRole('heading', { level: 1, name: 'Train' })).toBeVisible();
		await expect(page.locator('body')).not.toContainText(/500|internal error/i);

		// Progress needs server data (the overview): the designed offline state in the shell.
		await nav.getByRole('link', { name: 'Progress' }).click();
		await expect(page).toHaveURL(/\/progress$/);
		await expect(page.getByTestId('offline-state')).toBeVisible();
		await expect(page.getByRole('heading', { level: 1, name: 'Progress' })).toBeVisible();
		await expect(nav.getByRole('link', { name: 'Progress' })).toHaveAttribute(
			'aria-current',
			'page'
		);
		await expect(page.locator('body')).not.toContainText(/500|internal error/i);

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

		// A full page load offline gets the precached offline screen, still in the shell, worded
		// for a device that is offline (not "can't reach the server").
		await page.reload();
		await expect(page).toHaveURL(/\/profile$/);
		await expect(page.getByTestId('offline-state')).toBeVisible();
		await expect(page.getByTestId('offline-state')).toContainText("You're offline");
		await expect(nav).toBeVisible();
		await expect(nav.getByRole('link', { name: 'Profile' })).toHaveAttribute(
			'aria-current',
			'page'
		);

		// …from which the other tabs still open. Coach needs server data too (its conversations):
		// the designed offline state in the shell, never a 500.
		await nav.getByRole('link', { name: 'Coach' }).click();
		await expect(page).toHaveURL(/\/coach$/);
		await expect(page.getByTestId('offline-state')).toBeVisible();
		await expect(page.getByRole('heading', { level: 1, name: 'Coach' })).toBeVisible();
		await expect(nav.getByRole('link', { name: 'Coach' })).toHaveAttribute('aria-current', 'page');
		await expect(page.locator('body')).not.toContainText(/500|internal error/i);

		// A full page load of Progress offline: the precached offline screen, in the shell.
		await nav.getByRole('link', { name: 'Progress' }).click();
		await expect(page).toHaveURL(/\/progress$/);
		await expect(page.getByTestId('offline-state')).toBeVisible();
		await page.reload();
		await expect(page).toHaveURL(/\/progress$/);
		await expect(page.getByTestId('offline-state')).toContainText("You're offline");
		await expect(nav.getByRole('link', { name: 'Progress' })).toHaveAttribute(
			'aria-current',
			'page'
		);

		// Back online, the screens load live data again: Progress, then Profile.
		await context.setOffline(false);
		await expect(page.getByRole('heading', { level: 1, name: 'Progress' })).toBeVisible();
		await expect(page.getByTestId('offline-state')).toHaveCount(0, { timeout: 15_000 });
		await expect(page.getByTestId('progress-period')).toBeVisible();
		await context.setOffline(true);
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

	test('the /offline document at its own URL never reloads itself', async ({ page }) => {
		// Healthy server: the recovery probe would succeed, and reloading /offline lands on the
		// offline screen again, so it must not probe or reload there at all.
		await page.goto('/offline');
		await expect(page.getByTestId('offline-state')).toContainText("You're offline");
		await page.evaluate(() => Object.assign(window, { __sameDocument: true }));
		const probes: string[] = [];
		page.on('request', (r) => r.url().endsWith('/api/health') && probes.push(r.url()));
		await page.waitForTimeout(3_000); // longer than the first retry delay (2 s)
		expect(await page.evaluate(() => '__sameDocument' in window)).toBe(true);
		expect(probes).toEqual([]);
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
