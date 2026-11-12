import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ACTIVE_WORKOUT_KEY } from '../src/lib/client/workout/active-flag';
import { DATA_TIMEOUT_MS } from '../src/lib/client/sw-network';
import { ACTIVE_LAUNCH_TIMEOUT_MS, START_URL } from '../src/lib/client/workout/launch';
import { expectNoSideScroll, isDesktopPage } from './desktop';
import { TABS } from './support';
import { readOutbox, seedKits, seedWorkout, workoutDay } from './workout-support';

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
		await expect(page.getByTestId('offline-state')).toContainText('You’re offline');
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
		await expect(page.getByTestId('offline-state')).toContainText('You’re offline');
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
		await expect(state).toContainText('Can’t reach the server');
		expect(await page.evaluate(() => navigator.onLine)).toBe(true);

		// The server comes back: with no `online` event to wait for, the screen's own retry
		// (backoff probe of /api/health) brings live data back without a tap.
		await context.unrouteAll({ behavior: 'ignoreErrors' });
		await expect(page.getByTestId('db-status')).toContainText(/connected · \d+ ms/i, {
			timeout: 20_000
		});
	});

	test('on lie-fi, a client-side data load gives up and shows the offline state', async ({
		page,
		context
	}) => {
		await page.goto('/today');
		await waitForController(page);

		// Connected, but the server never answers (context-level: the worker's fetches too). The
		// health probe hangs as well, so the screen's own retry cannot recover mid-test.
		const hang = () => {};
		await context.route('**/__data.json*', hang);
		await context.route('**/api/health', hang);
		const asked = Date.now();
		await page
			.getByRole('navigation', { name: 'Primary' })
			.getByRole('link', { name: 'Profile' })
			.click();
		const state = page.getByTestId('offline-state');
		// The worker's bounded wait, not the minute or more a hung request takes.
		await expect(state).toContainText('Can’t reach the server', {
			timeout: DATA_TIMEOUT_MS + 4_000
		});
		expect(Date.now() - asked).toBeGreaterThanOrEqual(DATA_TIMEOUT_MS - 500);
		await expect(page).toHaveURL(/\/profile$/);
		await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
		await expect(page.locator('body')).not.toContainText(/500|503|internal error/i);
		await context.unrouteAll({ behavior: 'ignoreErrors' });
	});

	test('navigation preload is on, and server-rendered pages still load through it', async ({
		page
	}) => {
		await page.goto('/today');
		await waitForController(page);
		expect(
			await page.evaluate(async () => {
				const registration = await navigator.serviceWorker.ready;
				return (await registration.navigationPreload.getState()).enabled;
			})
		).toBe(true);

		// A controlled load of a server-rendered page gets its live data (the preload's answer).
		await page.goto('/profile');
		await expect(page.getByTestId('db-status')).toContainText(/connected · \d+ ms/i, {
			timeout: 15_000
		});
		await expect(page.getByTestId('offline-state')).toHaveCount(0);
	});

	test('the /offline document at its own URL never reloads itself', async ({ page }) => {
		// Healthy server: the recovery probe would succeed, and reloading /offline lands on the
		// offline screen again, so it must not probe or reload there at all.
		await page.goto('/offline');
		await expect(page.getByTestId('offline-state')).toContainText('You’re offline');
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
		// The current exercise's card (the side list holding its name too is hidden on a phone).
		await expect(page.getByRole('region', { name: 'Back squat' })).toBeVisible();
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
		await expect(page.getByTestId('offline-state')).toContainText('You’re offline');
		await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
	});

	test('on lie-fi, a launch mid-workout gives the server less time before opening the logger', async ({
		page,
		context
	}) => {
		await workoutInProgress(page, context);

		// Connected, but the start URL's document never answers: neither the worker's own fetch
		// (context-level route) nor the browser's navigation preload, which routes never see, so a
		// minute of latency on the page's network holds the preload instead.
		await context.route(`**${START_URL}`, () => {});
		await (
			await context.newCDPSession(page)
		).send('Network.emulateNetworkConditions', {
			offline: false,
			latency: 60_000,
			downloadThroughput: -1,
			uploadThroughput: -1
		});
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
		await expect(page.getByTestId('offline-state')).toContainText('You’re offline');
	});

	/** Today on the page's clock: the day the offline screen lists saved kits for. */
	const pageDay = (page: Page) =>
		page.evaluate(() => {
			const d = new Date();
			const pad = (n: number) => String(n).padStart(2, '0');
			return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
		});

	/** axe in both themes: the page as it is, then in the light theme. */
	async function audit(page: Page, what: string) {
		for (const theme of ['dark', 'light']) {
			await page.evaluate((t) => {
				if (t === 'light') document.documentElement.dataset.theme = t;
				else delete document.documentElement.dataset.theme;
			}, theme);
			const { violations } = await new AxeBuilder({ page })
				.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
				.analyze();
			const found = violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
			expect(found, `${what}, ${theme}`).toEqual([]);
		}
		await page.evaluate(() => delete document.documentElement.dataset.theme);
	}

	test("launching offline with no workout in progress lists today's saved sessions, and Start starts one", async ({
		page,
		context
	}) => {
		// No signal for the workout API either (context-level: the worker's fetches too), so the
		// kit request fails at once and the started workout's sync never reaches Postgres.
		await context.route('**/api/workouts/**', (route) => route.abort('internetdisconnected'));
		// Profile saves no kits, so the device holds only the ones seeded here.
		await page.goto('/profile');
		await waitForController(page);
		const today = await workoutDay(await pageDay(page));
		const yesterday = await workoutDay('2000-01-01');
		await seedKits(page, [yesterday.run, today.strength, today.run, today.other]);

		await context.setOffline(true);
		await page.goto(START_URL);
		await expect(page).toHaveURL(/\/today$/);
		await expect(page.getByTestId('offline-state')).toContainText('You’re offline');
		const sessions = page.getByTestId('offline-today').getByTestId('offline-session');
		// Today's, in the order Today saved them; another day's kit is left out.
		await expect(sessions).toHaveCount(3);
		await expect(sessions.nth(0)).toContainText('Lower body & pull');
		await expect(sessions.nth(0)).toContainText('Strength · 5 exercises');
		await expect(sessions.nth(1)).toContainText('Intervals');
		await expect(sessions.nth(2)).toContainText('Muay Thai · 90 min');
		await expect(sessions.getByTestId('offline-start-workout')).toHaveCount(3);
		await expectNoSideScroll(page);
		await audit(page, "the offline screen with today's sessions");

		const start = sessions.nth(0).getByTestId('offline-start-workout');
		await expect(start).toHaveAttribute(
			'href',
			`/workout?start=${encodeURIComponent(today.strength.plannedLineage!)}`
		);
		if (isDesktopPage(page)) {
			// A desktop window: the keyboard reaches it, with a focus ring.
			await start.focus();
			await expect(start).toHaveCSS('outline-style', 'solid');
			await page.keyboard.press('Enter');
		} else {
			await start.click();
		}
		// Started from the saved kit, with no signal: the logger, and its start waiting to sync.
		await expectLogger(page);
		await expect
			.poll(async () => (await readOutbox(page)).map((e) => e.envelope.type))
			.toEqual(['workout.start']);
	});

	test('an offline launch with no saved kits says how to keep them ready', async ({
		page,
		context
	}) => {
		await page.goto('/profile');
		await waitForController(page);

		await context.setOffline(true);
		await page.goto(START_URL);
		await expect(page.getByTestId('offline-state')).toContainText('You’re offline');
		await expect(page.getByTestId('offline-today-empty')).toContainText(
			'No sessions saved for today'
		);
		await expect(page.getByTestId('offline-session')).toHaveCount(0);
		// An ad-hoc workout needs no kit: still offered.
		await expect(page.getByTestId('offline-log-other')).toHaveAttribute('href', '/workout');
		await audit(page, 'the offline screen with no saved sessions');

		// Any other screen reloaded offline keeps to its own offline state.
		await page.goto('/progress');
		await expect(page.getByTestId('offline-state')).toBeVisible();
		await expect(page.getByTestId('offline-today')).toHaveCount(0);
	});

	test('an offline cold start mid-workout runs from the precache alone: a set logs, the menu opens', async ({
		page,
		context
	}) => {
		// No workout page has loaded on this device: everything it runs must come from what the
		// worker precached at install, its lazy logger, store and menu included.
		await context.route('**/api/workouts/**', (route) => route.abort('internetdisconnected'));
		await page.goto('/profile');
		await waitForController(page);
		const kits = await workoutDay();
		await seedWorkout(page, kits.strength);

		await context.setOffline(true);
		await page.goto('/workout');
		await expectLogger(page);
		await page.getByTestId('set-logger').getByTestId('complete-set').click();
		await expect
			.poll(async () => (await readOutbox(page)).map((e) => e.envelope.type))
			.toEqual(['workout.start', 'set.log']);
		await page.getByTestId('workout-menu-button').click();
		await expect(page.getByTestId('workout-menu')).toBeVisible();
		await expect(page.getByTestId('offline-state')).toHaveCount(0);
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
