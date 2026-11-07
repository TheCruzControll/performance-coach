/**
 * The workout screen's shell (/workout): restored from IndexedDB alone, prerendered and data-free,
 * with its designed states. Sync is held ('hold'), so nothing here writes Postgres. The desktop
 * layout is workout-shell.desktop.e2e.ts.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { expectNoShift, expectNoSideScroll } from './desktop';
import { captureScreen, signedOut } from './support';
import { forceSafeArea, gotoWorkout, seedWorkout, workoutDay } from './workout-support';

type Kits = Awaited<ReturnType<typeof workoutDay>>;
let kits: Kits;
test.beforeAll(async () => {
	kits = await workoutDay();
});

const EXERCISES = ['Back squat', 'Leg press', 'Romanian deadlift', 'Pull-up', 'Plank'];

const ready = (page: Page) => page.locator('main#main[data-ready]');

async function audit(page: Page): Promise<string[]> {
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) =>
		v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
	);
}

/** Every link and button on the screen is at least 44 × 44 px. */
async function expectTargets(page: Page) {
	const small = await page.locator('main a:visible, main button:visible').evaluateAll((elements) =>
		elements
			.map((el) => ({ el, box: el.getBoundingClientRect() }))
			.filter(({ box }) => box.width < 44 || box.height < 44)
			.map(({ el, box }) => `${el.textContent?.trim()}: ${box.width}×${box.height}`)
	);
	expect(small).toEqual([]);
}

/** 'pc-offline' opened by a newer app (version 2), from another page of this browser. */
async function upgradeFromAnotherPage(page: Page) {
	const other = await page.context().newPage();
	await other.goto('/robots.txt');
	await other.evaluate(
		() =>
			new Promise<void>((resolve, reject) => {
				const request = indexedDB.open('pc-offline', 2);
				request.onsuccess = () => {
					request.result.close();
					resolve();
				};
				request.onerror = () => reject(request.error);
			})
	);
	await other.close();
}

/** Makes indexedDB.open throw, as a browser that refuses storage does. */
const refuseStorage = (page: Page) =>
	page.addInitScript(() => {
		IDBFactory.prototype.open = () => {
			throw new DOMException('The operation is insecure.', 'SecurityError');
		};
	});

test.describe('the workout screen (IndexedDB only)', () => {
	// page.route on WebKit sees no request from a page the service worker controls.
	test.use({ serviceWorkers: 'block' });

	test('restores the strength workout with every /api request aborted; a reload is identical', async ({
		page
	}) => {
		const api: string[] = [];
		await page.route('**/api/**', (route) => {
			api.push(`${route.request().method()} ${route.request().url()}`);
			return route.abort();
		});
		await seedWorkout(page, kits.strength);
		await gotoWorkout(page);

		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lower body & pull');
		// The current exercise (the strength view's details: workout-strength.e2e.ts).
		await expect(page.getByRole('heading', { level: 2 })).toHaveText('Back squat');
		const main = page.getByTestId('workout-main');
		const squat = main.getByTestId('exercise');
		await expect(squat.getByTestId('exercise-target')).toContainText(
			'Work up to a set of 5 @ RPE 7'
		);
		await expect(squat.getByTestId('set')).toHaveText([
			/^1\s*5 reps · RPE 7\s*Now$/,
			/^2\s*5 reps · ≈ 100 kg\s*To do$/,
			/^3\s*5 reps · ≈ 100 kg\s*To do$/,
			/^4\s*5 reps · ≈ 100 kg\s*To do$/
		]);
		// The stopwatch runs from the start, 12 minutes ago.
		await expect(page.getByRole('timer', { name: 'Workout time' })).toHaveText(/^\s*12:\d\d\s*$/);
		// The set logger shows once its chunk and the store have loaded, after the first render:
		// compare the view with it on both sides of the reload.
		const logger = main.getByTestId('set-logger');
		await expect(logger).toBeVisible();
		const restored = await main.innerText();

		await page.reload();
		await expect(ready(page)).toBeAttached();
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lower body & pull');
		await expect(logger).toBeVisible();
		expect(await main.innerText()).toBe(restored);
		// Nothing is read from the server; the sync engine's POSTs are workout-sync-wiring's.
		expect(api.filter((r) => r.includes('/api/workouts') && !r.startsWith('POST '))).toEqual([]);
	});

	test('a workout of another kind is sent to its own route before any view renders', async ({
		page
	}) => {
		await seedWorkout(page, kits.run);
		await page.goto('/workout?start=x');
		await expect(page).toHaveURL(/\/workout\/run\?start=x$/);
		await expect(page.getByTestId('workout-main')).toHaveCount(0);
	});

	test('with no workout, the empty state links to Today', async ({ page }, testInfo) => {
		await gotoWorkout(page);
		const empty = page.getByTestId('workout-empty');
		await expect(empty.getByRole('heading', { name: 'No workout in progress' })).toBeVisible();
		await expect(empty.getByRole('link', { name: 'Go to Today' })).toHaveAttribute(
			'href',
			'/today'
		);
		await expect(page.getByRole('link', { name: 'Minimise' })).toHaveAttribute('href', '/today');
		await expect(page.getByRole('timer')).toHaveCount(0);
		await captureScreen(page, testInfo, 'workout-empty');
	});

	test('the prerendered HTML is the same signed in and signed out, and holds no workout', async ({
		page,
		playwright,
		baseURL
	}) => {
		const signedIn = await page.request.get('/workout');
		expect(signedIn.status()).toBe(200);
		const anonymous = await playwright.request.newContext({ baseURL, storageState: signedOut });
		const outside = await anonymous.get('/workout');
		expect(outside.status()).toBe(200);
		const html = await signedIn.text();
		expect(await outside.text()).toBe(html);
		await anonymous.dispose();

		expect(html).toContain('id="main"');
		expect(html).toContain('Workout · Performance Coach');
		for (const name of [...EXERCISES, kits.strength.title]) expect(html).not.toContain(name);
	});

	test('nothing moves as the workout replaces the skeleton', async ({ page }) => {
		await seedWorkout(page, kits.strength);
		// Hold the restore: a readwrite transaction on the workouts store, until released.
		await page.addInitScript(() => {
			if (!location.pathname.startsWith('/workout')) return;
			let held = true;
			Object.assign(window, { __releaseRestore: () => (held = false) });
			const request = indexedDB.open('pc-offline');
			request.onsuccess = () => {
				const db = request.result;
				db.onversionchange = () => db.close();
				const store = db.transaction('workouts', 'readwrite').objectStore('workouts');
				const spin = () => {
					if (held) store.count().onsuccess = spin;
					else db.close();
				};
				spin();
			};
		});
		await page.goto('/workout');
		await expect(page.getByTestId('workout-restoring')).toBeVisible();
		await page.waitForFunction(() => document.fonts.status === 'loaded');
		const header = page.getByTestId('workout-header');
		await expectNoShift(page, {
			boxes: [header, page.getByRole('link', { name: 'Minimise' })],
			action: async () => {
				await page.evaluate(() =>
					(window as unknown as { __releaseRestore: () => void }).__releaseRestore()
				);
				await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lower body & pull');
			}
		});
	});

	test('applies the safe areas itself: no shell does here', async ({ page }) => {
		await seedWorkout(page, kits.strength);
		await gotoWorkout(page);
		await forceSafeArea(page, { top: 47, bottom: 34 });
		const padding = (testId: string, side: 'top' | 'bottom') =>
			page
				.getByTestId(testId)
				.evaluate(
					(el, s) => parseFloat(getComputedStyle(el).getPropertyValue(`padding-${s}`)),
					side
				);
		expect(await padding('workout-header', 'top')).toBeGreaterThanOrEqual(47);
		expect(await padding('workout-foot', 'bottom')).toBeGreaterThanOrEqual(34);
		await forceSafeArea(page, { top: 0, bottom: 0 });
		expect(await padding('workout-header', 'top')).toBeLessThan(47);
		expect(await padding('workout-foot', 'bottom')).toBe(0);
	});

	test('a browser that cannot keep a workout says so, and what to do', async ({
		page
	}, testInfo) => {
		await refuseStorage(page);
		await gotoWorkout(page);
		const state = page.getByTestId('workout-no-storage');
		await expect(
			state.getByRole('heading', { name: "This browser can't keep a workout" })
		).toBeVisible();
		await expect(state).toContainText('Private browsing is the usual cause');
		await expect(state.getByRole('button', { name: 'Try again' })).toBeVisible();
		await captureScreen(page, testInfo, 'workout-no-storage');
	});

	test('a newer app upgrading the database under the page asks for a reload', async ({
		page
	}, testInfo) => {
		await seedWorkout(page, kits.strength);
		await gotoWorkout(page);
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lower body & pull');

		await upgradeFromAnotherPage(page);
		const state = page.getByTestId('workout-app-updated');
		await expect(
			state.getByRole('heading', { name: 'App updated — reload to continue' })
		).toBeVisible();
		await expect(state.getByRole('button', { name: 'Reload' })).toBeVisible();
		await expect(page.getByTestId('workout-main')).toHaveCount(0);
		await captureScreen(page, testInfo, 'workout-app-updated');
	});

	test('no sideways scroll at 393 px or at 150 % text; every target is 44 px', async ({
		page
	}, testInfo) => {
		await seedWorkout(page, kits.strength);
		await gotoWorkout(page);
		await expectNoSideScroll(page);
		await expectTargets(page);
		await captureScreen(page, testInfo, 'workout-active');

		await page.evaluate(() => (document.documentElement.style.fontSize = '150%'));
		await expectNoSideScroll(page);
		await expectTargets(page);
	});

	for (const theme of ['dark', 'light'] as const) {
		test(`every state has no WCAG A/AA violations (${theme} theme)`, async ({ page }) => {
			await page.addInitScript(
				(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
				theme
			);
			await gotoWorkout(page);
			await expect(page.getByTestId('workout-empty')).toBeVisible();
			expect(await audit(page), 'empty').toEqual([]);

			await seedWorkout(page, kits.strength);
			await gotoWorkout(page);
			await expect(page.getByTestId('workout-main')).toBeVisible();
			expect(await audit(page), 'active').toEqual([]);

			await upgradeFromAnotherPage(page);
			await expect(page.getByTestId('workout-app-updated')).toBeVisible();
			expect(await audit(page), 'app updated').toEqual([]);

			await refuseStorage(page);
			await page.reload();
			await expect(page.getByTestId('workout-no-storage')).toBeVisible();
			expect(await audit(page), 'no storage').toEqual([]);
		});
	}
});

test.describe('the workout screen offline (service worker)', () => {
	// Playwright emulates offline for service-worker traffic only in Chromium.
	test.skip(({ browserName }) => browserName !== 'chromium', 'offline emulation is Chromium-only');

	test('reloads offline from the precache, whatever the query, and restores the workout', async ({
		page,
		context
	}) => {
		await page.goto('/workout');
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
			timeout: 15_000
		});
		await seedWorkout(page, kits.strength);

		await context.setOffline(true);
		for (const path of ['/workout', '/workout?start=x']) {
			await page.goto(path);
			await expect(ready(page)).toBeAttached();
			await expect(page.getByRole('heading', { level: 1 })).toHaveText('Lower body & pull');
			await expect(page.getByTestId('exercise').getByRole('heading', { level: 2 })).toHaveText(
				'Back squat'
			);
		}
		await context.setOffline(false);
	});

	test('Cache Storage holds the prerendered /workout, and no dynamic page, data or API answer', async ({
		page
	}) => {
		await page.goto('/today');
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
			timeout: 15_000
		});
		for (const path of ['/profile', '/workout', '/workout?start=x']) await page.goto(path);
		await expect(ready(page)).toBeAttached();

		const stored = await page.evaluate(async () => {
			const found: string[] = [];
			for (const key of await caches.keys()) {
				const cache = await caches.open(key);
				for (const request of await cache.keys()) {
					const url = new URL(request.url);
					found.push(url.pathname + url.search);
				}
			}
			return found;
		});
		expect(stored).toContain('/workout');
		expect(stored).not.toContain('/workout?start=x');
		for (const path of ['/today', '/profile', '/']) expect(stored).not.toContain(path);
		expect(stored.filter((path) => path.includes('__data.json'))).toEqual([]);
		expect(stored.filter((path) => path.startsWith('/api/'))).toEqual([]);
	});
});
