import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ACTIVE_WORKOUT_KEY } from '../src/lib/client/workout/active-flag';
import { ACTIVE_LAUNCH_TIMEOUT_MS, START_URL } from '../src/lib/client/workout/launch';
import { TABS } from './support';
import { seedWorkout, workoutDay } from './workout-support';

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

	/**
	 * A strength workout in progress on this device, which the workout page's store has flagged for
	 * launch (launch.ts), with the page controlled by the worker. Its sync is held unanswered
	 * (context-level, so it also covers requests that pass through the worker): nothing reaches
	 * Postgres.
	 */
	async function workoutInProgress(page: Page, context: BrowserContext) {
		await context.route('**/api/workouts/**', () => {});
		const kits = await workoutDay();
		const workoutId = await seedWorkout(page, kits.strength);
		await page.goto('/workout');
		await waitForController(page);
		await expect(page.locator('main#main[data-store]')).toBeAttached();
		await expect
			.poll(() => page.evaluate((key) => localStorage.getItem(key), ACTIVE_WORKOUT_KEY))
			.toContain(workoutId);
	}

	/** The workout page's logger, ready for the next set, and no offline screen. */
	async function expectLogger(page: Page) {
		await expect(page).toHaveURL(/\/workout$/);
		await expect(page.getByTestId('complete-set')).toBeEnabled();
		await expect(page.getByText('Back squat').first()).toBeVisible();
		await expect(page.getByTestId('offline-state')).toHaveCount(0);
	}

	test('launching offline mid-workout opens the logger, not the offline screen', async ({
		page,
		context
	}) => {
		await workoutInProgress(page, context);

		await context.setOffline(true);
		// The start URL offline: the worker serves the offline screen, which opens the workout.
		await page.goto(START_URL).catch(() => {}); // replaced while it loads
		await expectLogger(page);

		// The offline screen at its own URL does the same.
		await page.goto('/offline').catch(() => {});
		await expectLogger(page);

		// Any other screen reloaded offline keeps its designed offline state, in the shell.
		await page.goto('/progress').catch(() => {});
		await expect(page).toHaveURL(/\/progress$/);
		await expect(page.getByTestId('offline-state')).toContainText("You're offline");
		await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
	});

	test('on lie-fi, a launch mid-workout gives the server less time before opening the logger', async ({
		page,
		context
	}) => {
		await workoutInProgress(page, context);

		// Connected, but the start URL's document never answers (context-level: the worker's fetch).
		await context.route(`**${START_URL}`, () => {});
		const asked = Date.now();
		await page.goto(START_URL, { waitUntil: 'commit' }).catch(() => {});
		await expect(page).toHaveURL(/\/workout$/);
		// Under the usual 6 s wait: the shorter launch timeout, plus two pages from the precache.
		expect(Date.now() - asked).toBeLessThan(ACTIVE_LAUNCH_TIMEOUT_MS + 3_500);
		await expectLogger(page);
	});

	test('after the workout finishes, an offline launch shows the offline screen again', async ({
		page,
		context
	}) => {
		await workoutInProgress(page, context);
		await page.getByTestId('workout-menu-button').click();
		const menu = page.getByTestId('workout-menu');
		await menu.getByTestId('menu-discard').click();
		await menu.getByTestId('confirm-discard').click();
		await expect(page.getByTestId('workout-empty')).toBeVisible();
		expect(await page.evaluate((key) => localStorage.getItem(key), ACTIVE_WORKOUT_KEY)).toBeNull();

		await context.setOffline(true);
		await page.goto(START_URL).catch(() => {});
		await expect(page).toHaveURL(/\/today$/);
		await expect(page.getByTestId('offline-state')).toContainText("You're offline");
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
