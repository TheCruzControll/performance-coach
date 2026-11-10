/**
 * The resume bar ((app)/ResumeBar.svelte, resume.ts): a workout in progress on this device is one
 * tap away from Today and every tab, after a reload and in a new page too, and never shows on the
 * workout pages; it returns to the same exercise, and a run to /workout/run. Today offers
 * 'Continue here' for a workout started on another device, and the two devices then share their
 * sets. A workout finished offline reads 'N changes waiting to sync' until the bar's own engine
 * has synced it. A fresh device creates no 'pc-offline' on any tab, except Today on a day with
 * sessions planned (it saves their kits). The app started offline (the service
 * worker's offline screen for /today) shows the bar, and it restores the workout exactly. The bar
 * never shifts the layout, is axe-clean in both themes, and in a desktop window sits in the
 * content column beside the rail, above the last element of every tab.
 *
 * Serial: the tests start workouts of the one owner and store a program (resetTrainingProfile
 * empties the workouts first). A test that holds or fails a request with page.route blocks the
 * service worker (WebKit's page.route does not see a controlled page's requests).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { WORKOUT_PATHS } from '../src/lib/client/workout/kinds';
import { DB_NAME, STORES } from '../src/lib/client/workout/names';
import type { RunKit, StartKit, StrengthKit } from '../src/lib/domain/workout';
import { createMutation } from '../src/lib/domain/workout/mutations';
import { boxOf, DESKTOP, expectCentredOver, expectNoShift, expectNoSideScroll } from './desktop';
import { PROGRAM_TZ, seedProgram } from './program-support';
import { captureScreen, query, resetTrainingProfile, TABS, trackConsoleErrors } from './support';
import { startFromKit } from './workout-start-support';
import { injectMutation, readOutbox, seedWorkout, workoutDay } from './workout-support';

test.use({ timezoneId: PROGRAM_TZ });

let strength: StrengthKit;
let run: RunKit;
test.beforeAll(async () => {
	const kits = await workoutDay();
	strength = adHoc(kits.strength);
	run = adHoc(kits.run);
});
test.beforeEach(async () => {
	await resetTrainingProfile();
});
test.afterAll(async () => {
	await resetTrainingProfile();
});

/** Ad hoc: the fixture's planned sessions are not in this database. */
function adHoc<K extends StartKit>(kit: K): K {
	const bare = { ...kit, plannedSessionId: null, plannedLineage: null, programId: null };
	if (bare.kind !== 'strength') return bare;
	return { ...bare, exercises: bare.exercises.map((e) => ({ ...e, plannedLineage: null })) };
}

const bar = (page: Page) => page.getByTestId('resume-bar');
const resumeLink = (page: Page) => page.getByTestId('resume-link');
const continueHere = (page: Page) => page.getByTestId('continue-here');
const heading = (page: Page) =>
	page.getByTestId('workout-main').getByTestId('exercise').getByRole('heading', { level: 2 });
const setRows = (page: Page) => page.getByTestId('workout-main').getByTestId('set');
const logger = (page: Page) => page.getByTestId('set-logger');

/** The bar has looked on `path` (it loads on idle after hydration): what it shows is settled. */
const looked = (page: Page, path: string) =>
	expect(page.locator(`[data-testid="resume-slot"][data-looked="${path}"]`)).toBeAttached({
		timeout: 10_000
	});

/**
 * Opens a screen and waits for the bar to have looked (so hydrated too); never for the network to
 * idle, which a held request or the bar's engine retrying a refused sync keeps from happening.
 */
async function openTab(page: Page, path: string) {
	await page.goto(path);
	await looked(page, path);
}

/** Every 'pc-offline' this origin has. */
const offlineDatabases = (page: Page) =>
	page.evaluate(
		async (name) => (await indexedDB.databases()).filter((db) => db.name === name).length,
		DB_NAME
	);

/** Moves the device to exercise `position`, as Next does. */
async function setPosition(page: Page, workoutId: string, position: number) {
	await page.evaluate(
		async ({ name, store, workoutId, position }) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(name);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			const objects = db.transaction(store, 'readwrite').objectStore(store);
			const read = objects.get(workoutId);
			await new Promise((resolve) => (read.onsuccess = resolve));
			const record = read.result as { device: { position: number } };
			record.device.position = position;
			objects.put(record);
			await new Promise((resolve) => (objects.transaction.oncomplete = resolve));
			db.close();
		},
		{ name: DB_NAME, store: STORES.workouts, workoutId, position }
	);
}

/** A workout finished on this device: its workout.finish queued and its record completed. */
async function finishHere(page: Page, workoutId: string) {
	await injectMutation(
		page,
		createMutation('workout.finish', { workoutId, at: new Date().toISOString(), payload: {} })
	);
	await page.evaluate(
		async ({ name, store, workoutId }) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(name);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			const objects = db.transaction(store, 'readwrite').objectStore(store);
			const read = objects.get(workoutId);
			await new Promise((resolve) => (read.onsuccess = resolve));
			objects.put({ ...read.result, status: 'completed', finishedAt: new Date().toISOString() });
			await new Promise((resolve) => (objects.transaction.oncomplete = resolve));
			db.close();
		},
		{ name: DB_NAME, store: STORES.workouts, workoutId }
	);
}

/** A set.log of the strength kit's exercise at `position`, as this device's logger queues it. */
const firstSetOf = (workoutId: string, position: number) => {
	const slot = strength.exercises[position - 1]!;
	return createMutation('set.log', {
		workoutId,
		at: new Date().toISOString(),
		payload: {
			position,
			exerciseId: slot.exercise.id,
			plannedLineage: null,
			setIndex: 1,
			reps: 5,
			seconds: null,
			metres: null,
			weight: 100,
			assistance: null,
			unit: 'kg',
			rpe: 8,
			missedReps: 0,
			isWarmup: false,
			isExtra: false
		}
	});
};

/** axe in both themes: the page as it is, then in the light theme. */
async function audit(page: Page, what: string) {
	for (const theme of ['dark', 'light']) {
		await page.evaluate((t) => {
			if (t === 'light') document.documentElement.dataset.theme = t;
			else delete document.documentElement.dataset.theme;
		}, theme);
		await page.waitForFunction(() =>
			document
				.getAnimations()
				.every(
					(a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity
				)
		);
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		const found = violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
		expect(found, `${what}, ${theme}`).toEqual([]);
	}
	await page.evaluate(() => delete document.documentElement.dataset.theme);
}

/**
 * Scrolled to the bottom, the screen's content (everything in flow in <main>, so its last element
 * too) ends above the bar.
 */
async function expectClearOfBar(page: Page, what: string) {
	await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
	const [content, chrome] = [await boxOf(page.locator('main#main')), await boxOf(bar(page))];
	expect(content.y + content.height, `${what}: the content ends above the bar`).toBeLessThanOrEqual(
		chrome.y + 1
	);
}

/** A second device: a new browser context with the same sign-in and window. */
async function otherDevice(browser: Browser, page: Page) {
	const context = await browser.newContext({
		storageState: await page.context().storageState(),
		viewport: page.viewportSize(),
		timezoneId: PROGRAM_TZ,
		serviceWorkers: 'block'
	});
	return { context, page: await context.newPage() };
}

test.describe('a workout in progress on this device', () => {
	test('Minimise: Today shows Resume workout, and so do Train, Progress, Coach and Profile, never the workout pages', async ({
		page,
		request
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		const { kit } = await startFromKit(page, request);
		await page.getByTestId('exercise-next').click();
		const second = (await heading(page).textContent())!.trim();
		expect(second).not.toBe('');
		await expect(bar(page)).toHaveCount(0); // never on the workout pages

		await page.getByRole('link', { name: 'Minimise' }).click();
		await expect(page).toHaveURL(/\/today$/);
		await expect(bar(page)).toBeVisible({ timeout: 10_000 });
		await expect(bar(page)).toContainText('Resume workout');
		await expect(page.getByTestId('resume-title')).toHaveText(kit.title);
		await expect(bar(page).getByTestId('stopwatch')).toHaveText(/\d+:\d\d/);
		await expect(bar(page).getByTestId('sync-pill')).toHaveText('Saved');
		await captureScreen(page, testInfo, 'today-resume');
		await audit(page, 'Today with the resume bar');

		for (const tab of TABS.slice(1)) {
			await page
				.getByRole('navigation', { name: 'Primary' })
				.getByRole('link', { name: tab.label })
				.click();
			await expect(page).toHaveURL(new RegExp(`${tab.path}$`));
			await looked(page, tab.path);
			await expect(bar(page), tab.label).toBeVisible();
			await expectClearOfBar(page, tab.label);
		}

		// A reload, and a new page in the same context, still show it.
		await page.reload();
		await looked(page, '/profile');
		await expect(bar(page)).toBeVisible();
		const another = await page.context().newPage();
		await openTab(another, '/train');
		await expect(bar(another)).toBeVisible();
		await another.close();

		// Back to the same exercise.
		await resumeLink(page).click();
		await expect(page).toHaveURL(/\/workout$/);
		await expect(heading(page)).toHaveText(second);
		await expect(bar(page)).toHaveCount(0);
		expect(errors).toEqual([]);
	});

	test('the bar appears without moving anything on the screen', async ({ page }) => {
		await openTab(page, '/today');
		await expect(bar(page)).toHaveCount(0);
		await seedWorkout(page, strength);
		const title = page.getByRole('heading', { level: 1 });
		const nav = page.getByRole('navigation', { name: 'Primary' });
		await expectNoShift(page, {
			boxes: [title, nav],
			action: async () => {
				// Back to the app: the bar looks again and finds the workout.
				await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
				await expect(bar(page)).toBeVisible();
			}
		});
	});

	test.describe('with the server held', () => {
		test.use({ serviceWorkers: 'block' });

		test('a run returns to /workout/run', async ({ page }) => {
			await page.route('**/api/workouts/**', () => {});
			await seedWorkout(page, run);
			await openTab(page, '/today');
			await expect(resumeLink(page)).toHaveAttribute('href', WORKOUT_PATHS.run);
			await expect(page.getByTestId('resume-title')).toHaveText(run.title);
			await resumeLink(page).click();
			await expect(page).toHaveURL(/\/workout\/run$/);
			await expect(page.locator('main#main[data-ready]')).toBeAttached();
		});

		test("a workout finished offline is 'waiting to sync' until the bar's engine syncs it", async ({
			page
		}) => {
			await page.route('**/api/workouts/sync', (route) => route.abort('internetdisconnected'));
			const workoutId = await seedWorkout(page, strength);
			await finishHere(page, workoutId);

			await openTab(page, '/train');
			await expect(resumeLink(page)).toContainText('2 changes waiting to sync');
			await resumeLink(page).click();
			await expect(page).toHaveURL(/\/progress\/workouts$/);
			// History's own badge, not the bar's 'N changes waiting to sync' below <main>.
			await expect(page.locator('main#main').getByText('Waiting to sync')).toBeVisible();
			await expect(bar(page)).toBeVisible();

			// The network is back: the bar's engine sends both changes from History.
			await page.unroute('**/api/workouts/sync');
			await page.evaluate(() => window.dispatchEvent(new Event('online')));
			await expect.poll(() => readOutbox(page), { timeout: 15_000 }).toEqual([]);
			await expect(bar(page)).toHaveCount(0);
			const rows = await query<{ status: string }>(
				'select status from workouts where client_id = $1',
				[workoutId]
			);
			expect(rows).toEqual([{ status: 'completed' }]);
			await page.reload();
			await expect(page.getByText('Waiting to sync')).toHaveCount(0);
			await expect(page.getByTestId('workout-row')).toContainText(strength.title);
		});
	});
});

test.describe('another device', () => {
	test('Today offers Continue here; this device shows its sets and logs one, which the first then shows', async ({
		page,
		request,
		browser
	}, testInfo) => {
		const { kit, workoutId } = await startFromKit(page, request);
		const first = kit.kind === 'strength' ? kit.exercises[0]!.exercise.name : '';

		const other = await otherDevice(browser, page);
		try {
			await openTab(other.page, '/today');
			await expect(bar(other.page)).toContainText('In progress on another device');
			await expect(other.page.getByTestId('resume-title')).toHaveText(kit.title);
			await captureScreen(other.page, testInfo, 'today-continue-here');
			await audit(other.page, 'Today offering Continue here');
			// Only Today asks.
			await other.page
				.getByRole('navigation', { name: 'Primary' })
				.getByRole('link', { name: 'Train' })
				.click();
			await looked(other.page, '/train');
			await expect(bar(other.page)).toHaveCount(0);
			await other.page.goBack();
			await looked(other.page, '/today');

			await continueHere(other.page).click();
			await expect(other.page).toHaveURL(/\/workout$/);
			await expect(heading(other.page)).toHaveText(first);
			await expect(other.page.locator('main#main[data-store]')).toBeAttached();

			// This device logs the first set, and it lands.
			const load = logger(other.page).getByTestId('logger-load').getByRole('spinbutton');
			await load.click();
			await load.fill('100');
			await load.press('Enter');
			await logger(other.page).getByTestId('complete-set').click();
			await expect(setRows(other.page).first()).toHaveAttribute('data-state', 'done');
			await expect.poll(() => readOutbox(other.page), { timeout: 15_000 }).toEqual([]);
			const landed = await query<{ n: number }>(
				`select count(*)::int as n from set_records s join workouts w on w.id = s.workout_id
				  where w.client_id = $1`,
				[workoutId]
			);
			expect(landed).toEqual([{ n: 1 }]);
		} finally {
			await other.context.close();
		}

		// The first device comes back to its workout: it shows the other device's set.
		await page.getByRole('link', { name: 'Minimise' }).click();
		await looked(page, '/today');
		await resumeLink(page).click();
		await expect(page).toHaveURL(/\/workout$/);
		await expect(heading(page)).toHaveText(first);
		await expect(setRows(page).first()).toHaveAttribute('data-state', 'done');
	});
});

test.describe('a fresh device', () => {
	/** Every tab but Today: Train, then the others through the navigation. */
	async function visitTabsButToday(page: Page) {
		await openTab(page, '/train');
		for (const tab of TABS.slice(2)) {
			await page
				.getByRole('navigation', { name: 'Primary' })
				.getByRole('link', { name: tab.label })
				.click();
			await looked(page, tab.path);
			await expect(bar(page)).toHaveCount(0);
		}
	}

	test("on a rest day, visiting every tab creates no 'pc-offline' database", async ({
		page,
		request
	}) => {
		await seedProgram(request, { fixture: 'today-rest', start: 'this_week' });
		await openTab(page, '/today');
		await expect(page.getByTestId('today-rest')).toBeVisible();
		// Its idle pass has run, with nothing to save.
		await expect(page.locator('[data-testid="today-plan"][data-kits="none"]')).toBeAttached({
			timeout: 10_000
		});
		await visitTabsButToday(page);
		expect(await offlineDatabases(page)).toBe(0);
	});

	test("on a workout day, only Today creates it, to keep today's sessions ready", async ({
		page,
		request
	}) => {
		await seedProgram(request, { fixture: 'workout-day', start: 'this_week' });
		await visitTabsButToday(page);
		expect(await offlineDatabases(page)).toBe(0);
		await page
			.getByRole('navigation', { name: 'Primary' })
			.getByRole('link', { name: 'Today' })
			.click();
		await expect(page.locator('[data-testid="today-plan"][data-kits="saved"]')).toBeAttached({
			timeout: 10_000
		});
		expect(await offlineDatabases(page)).toBe(1);
	});
});

test.describe('the app started offline', () => {
	// Playwright emulates offline for service-worker traffic only in Chromium.
	test.skip(({ browserName }) => browserName !== 'chromium', 'offline emulation is Chromium-only');

	test('the offline screen for /today shows Resume workout, which restores the workout exactly', async ({
		page,
		context
	}, testInfo) => {
		await openTab(page, '/today');
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
			timeout: 15_000
		});
		// The device goes offline before the bar could send anything: the workout is seeded then.
		await context.setOffline(true);
		const workoutId = await seedWorkout(page, strength, { startedMinutesAgo: 23 });
		await setPosition(page, workoutId, 2);
		await injectMutation(page, firstSetOf(workoutId, 2));

		await page.goto('/today');
		await expect(page.getByTestId('offline-state')).toBeVisible();
		await looked(page, '/today');
		await expect(resumeLink(page)).toContainText('Resume workout');
		// The stopwatch's text starts with the space after its icon.
		await expect(bar(page).getByTestId('stopwatch')).toHaveText(/^\s*2[3-9]:\d\d$/);
		await expect(bar(page).getByTestId('sync-pill')).toHaveText('Offline · 2 pending');
		await captureScreen(page, testInfo, 'offline-resume');
		await audit(page, 'the offline screen with the resume bar');

		await resumeLink(page).click();
		await expect(page).toHaveURL(/\/workout$/);
		await expect(heading(page)).toHaveText(strength.exercises[1]!.exercise.name);
		await expect(setRows(page).first()).toHaveAttribute('data-state', 'done');
		await expect(page.getByTestId('workout-header').getByTestId('stopwatch')).toHaveText(
			/^\s*2[3-9]:\d\d$/
		);
		await context.setOffline(false);
	});
});

test.describe('in a desktop window', () => {
	test.use({ ...DESKTOP, serviceWorkers: 'block' });

	const background = (locator: Locator) =>
		locator.evaluate((el) => getComputedStyle(el).backgroundColor);

	test('the bar sits in the content column beside the rail, clear of every tab’s last element, with hover and focus states', async ({
		page
	}, testInfo) => {
		await page.route('**/api/workouts/**', () => {});
		await seedWorkout(page, strength);
		const rail = page.getByRole('navigation', { name: 'Primary' });

		for (const tab of TABS) {
			await openTab(page, tab.path);
			await expect(bar(page), tab.label).toBeVisible();
			await expectCentredOver(page, bar(page), page.locator('main#main'));
			const [railBox, barBox] = [await boxOf(rail), await boxOf(bar(page))];
			expect(barBox.x, `${tab.label}: the bar is inset by the rail`).toBeGreaterThan(
				railBox.x + railBox.width
			);
			await expectNoSideScroll(page);
			await expectClearOfBar(page, tab.label);
		}

		await openTab(page, '/today');
		await captureScreen(page, testInfo, 'desktop-today-resume');
		const link = resumeLink(page);
		await page.mouse.move(0, 0);
		const rest = await background(link);
		await link.hover();
		await expect.poll(() => background(link), 'the link on hover').not.toBe(rest);
		await page.mouse.move(0, 0);
		await expect.poll(() => background(link)).toBe(rest);
		await link.focus();
		await expect(link).toHaveCSS('outline-style', 'solid');
	});

	test('the bar appears without moving anything, on the rail layout too', async ({ page }) => {
		await openTab(page, '/today');
		await seedWorkout(page, strength);
		await expectNoShift(page, {
			boxes: [
				page.getByRole('heading', { level: 1 }),
				page.getByRole('navigation', { name: 'Primary' })
			],
			action: async () => {
				await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
				await expect(bar(page)).toBeVisible();
			}
		});
	});
});
