/**
 * Starting a workout from /workout?start=<lineage> and ?new=run|other against the real server
 * (StartFlow.svelte, client/workout/start.ts): M3's 'workout-day' program, seeded this week, has
 * a strength session, an interval run and a Muay Thai class today. Each starts by URL and shows
 * its plan on its own route, and Postgres gets the workout pinned to its planned session; the
 * loading, signed-out, conflict, offline and missing states are designed, axe-clean and
 * captured; a kit saved earlier starts offline and syncs later; an ad-hoc run starts from the
 * empty workout screen. Serial: it stores a program, which empties the workouts. A spec that
 * holds or fails a request with page.route blocks the service worker (WebKit's page.route does
 * not see a controlled page's requests).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { DB_NAME, STORES } from '../src/lib/client/workout/names';
import type { StartKit } from '../src/lib/domain/workout';
import {
	BELOW_DESKTOP_WIDTH,
	boxOf,
	DESKTOP,
	DESKTOP_WIDTHS,
	expectNoSideScroll,
	layoutWidth,
	tokenPx
} from './desktop';
import { PROGRAM_TZ, seedProgram, type SeededProgram, type SeededSession } from './program-support';
import { captureScreen, query, SAME_ORIGIN, signedOut } from './support';
import { readOutbox } from './workout-support';

test.use({ timezoneId: PROGRAM_TZ });

let seeded: SeededProgram;
test.beforeAll(async ({ request }) => {
	seeded = await seedProgram(request, { fixture: 'workout-day', start: 'this_week' });
});

/** Today's session titled `title`. */
const today = (title: string): SeededSession =>
	seeded.sessions.find((s) => s.title === title && s.date === seeded.today)!;
const strength = () => today('Lower body & pull');
const run = () => today('Intervals');
const startUrl = (session: SeededSession) => `/workout?start=${session.lineage}`;
const KIT_ROUTE = '**/api/workouts/kit**';

const loading = (page: Page) => page.getByTestId('workout-start-loading');
const sheet = (page: Page) => page.getByTestId('start-conflict-sheet');

/** The workout in progress on this device, as IndexedDB holds it. */
const activeWorkout = (page: Page) =>
	page.evaluate(
		async ({ name, store }) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(name);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			const all = db.transaction(store, 'readonly').objectStore(store).getAll();
			const rows = await new Promise<{ id: string; status: string; kit: StartKit | null }[]>(
				(resolve) => (all.onsuccess = () => resolve(all.result))
			);
			db.close();
			const active = rows.find((w) => w.status === 'in_progress');
			return active ? { id: active.id, kit: active.kit } : null;
		},
		{ name: DB_NAME, store: STORES.workouts }
	);

/** How many workouts this device holds. */
async function countWorkouts({ name, store }: { name: string; store: string }) {
	const db = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(name);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	const count = db.transaction(store, 'readonly').objectStore(store).count();
	const n = await new Promise<number>((resolve) => (count.onsuccess = () => resolve(count.result)));
	db.close();
	return n;
}

/** Saves a kit on this device, as Today does on idle (the store must have created the database). */
const saveKit = (page: Page, lineage: string, kit: StartKit) =>
	page.evaluate(
		async ({ name, store, lineage, kit }) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(name);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			const tx = db.transaction(store, 'readwrite');
			tx.objectStore(store).put({ lineage, kit, savedAt: Date.now() });
			await new Promise((resolve) => (tx.oncomplete = resolve));
			db.close();
		},
		{ name: DB_NAME, store: STORES.kits, lineage, kit }
	);

const workoutRows = (clientId: string) =>
	query<{
		status: string;
		lineage: string | null;
		session: string | null;
		session_lineage: string | null;
	}>(
		`select w.status, w.planned_lineage_id::text as lineage, w.planned_session_id::text as session,
		        p.lineage_id::text as session_lineage
		   from workouts w left join planned_sessions p on p.id = w.planned_session_id
		  where w.client_id = $1`,
		[clientId]
	);

/** Once the page's engine has flushed: the workout's row in Postgres. */
async function landed(page: Page, clientId: string, status = 'in_progress') {
	await expect.poll(() => readOutbox(page), { timeout: 15_000 }).toEqual([]);
	await expect.poll(async () => (await workoutRows(clientId))[0]?.status).toBe(status);
	return (await workoutRows(clientId))[0]!;
}

/** Starts today's strength session by URL and waits for its route. */
async function startStrength(page: Page) {
	await page.goto(startUrl(strength()));
	await expect(page).toHaveURL(/\/workout$/);
	await expect(page.getByTestId('exercise').getByRole('heading', { level: 2 })).toHaveText(
		'Back squat'
	);
	return (await activeWorkout(page))!;
}

/** The start state sits at the readable width, centred, and nothing scrolls sideways. */
async function expectReadableAndCentred(page: Page) {
	const column = await boxOf(page.getByTestId('workout-start'));
	const readable = await tokenPx(page, '--content-readable');
	expect(Math.abs(column.width - readable), `the column is ${column.width}px`).toBeLessThanOrEqual(
		1
	);
	const right = (await layoutWidth(page)) - (column.x + column.width);
	expect(Math.abs(column.x - right), `gaps ${column.x} and ${right}`).toBeLessThanOrEqual(1);
}

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

/** Holds every kit request until `release` is called; then it reaches the server. */
async function holdKits(page: Page) {
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	const requests: string[] = [];
	await page.route(KIT_ROUTE, async (route: Route) => {
		requests.push(route.request().url());
		await held;
		await route.continue();
	});
	return { release, requests };
}

const fontsLoaded = (page: Page) => page.waitForFunction(() => document.fonts.status === 'loaded');

test.describe('starting a planned session', () => {
	test('the strength session starts by URL, shows its plan, and Postgres has it in progress, pinned to its planned session', async ({
		page
	}) => {
		const { id, kit } = await startStrength(page);
		expect(kit).toMatchObject({ kind: 'strength', plannedLineage: strength().lineage });
		await expect(page.getByTestId('workout-header')).toContainText('Lower body & pull');
		// The query is gone: a reload restores the workout instead of starting another.
		expect(new URL(page.url()).search).toBe('');

		const row = await landed(page, id);
		expect(row).toEqual({
			status: 'in_progress',
			lineage: strength().lineage,
			session: kit!.plannedSessionId,
			session_lineage: strength().lineage
		});
	});

	test('the run starts on its own route with its planned segments', async ({ page }) => {
		await page.goto(startUrl(run()));
		await expect(page).toHaveURL(/\/workout\/run$/);
		await expect(page.getByTestId('run-entry').getByRole('heading', { level: 2 })).toHaveText(
			'Warm-up'
		);
		await expect(page.getByTestId('run-segment')).toHaveCount(14);
		const { id } = (await activeWorkout(page))!;
		expect(await landed(page, id)).toMatchObject({ lineage: run().lineage });
	});

	test('the class starts on its own route with its plan', async ({ page }) => {
		const session = today('Muay Thai class');
		await page.goto(startUrl(session));
		await expect(page).toHaveURL(/\/workout\/session$/);
		await expect(page.getByTestId('session-plan')).toHaveText('Class · 90 min · RPE 7');
		const { id } = (await activeWorkout(page))!;
		expect(await landed(page, id)).toMatchObject({ lineage: session.lineage });
	});

	test('a second start while one is in progress offers Resume or Discard; Discard abandons the synced one', async ({
		page
	}, testInfo) => {
		const first = await startStrength(page);
		await landed(page, first.id);

		await page.goto(startUrl(run()));
		await expect(sheet(page)).toBeVisible();
		const dialog = page.getByRole('dialog', { name: 'Lower body & pull is in progress' });
		await expect(dialog).toBeVisible();
		await expect(page.getByTestId('start-conflict-consequence')).toHaveText(
			'It has synced, so discarding keeps it in your history as abandoned, with everything you logged.'
		);
		await expect(page.getByTestId('start-resume')).toHaveText('Resume Lower body & pull');
		await captureScreen(page, testInfo, 'workout-start-conflict');
		await audit(page, 'the conflict sheet');

		// Dismissed, the page offers both again.
		await page.keyboard.press('Escape');
		await expect(sheet(page)).toBeHidden();
		const conflict = page.getByTestId('workout-start-conflict');
		await expect(conflict).toContainText('A workout is already in progress');
		await audit(page, 'the conflict state');
		await conflict.getByTestId('start-conflict-options').click();
		await expect(sheet(page)).toBeVisible();

		await page.getByTestId('start-discard').click();
		await expect(page).toHaveURL(/\/workout\/run$/);
		const second = (await activeWorkout(page))!;
		expect(second.id).not.toBe(first.id);
		expect(await landed(page, second.id)).toMatchObject({ lineage: run().lineage });
		expect((await workoutRows(first.id))[0]!.status).toBe('abandoned');
	});

	test('Resume goes back to the workout in progress and starts nothing', async ({ page }) => {
		const first = await startStrength(page);
		await page.goto(startUrl(run()));
		await page.getByTestId('start-resume').click();
		await expect(page).toHaveURL(/\/workout$/);
		await expect(page.getByTestId('workout-header')).toContainText('Lower body & pull');
		expect((await activeWorkout(page))!.id).toBe(first.id);
		await landed(page, first.id);
		expect(await page.evaluate(countWorkouts, { name: DB_NAME, store: STORES.workouts })).toBe(1);
	});

	test('a session no longer in the plan says so, with Today and a session of your own', async ({
		page
	}) => {
		await page.goto('/workout?start=00000000-0000-4000-8000-00000000dead');
		const missing = page.getByTestId('workout-start-missing');
		await expect(missing).toContainText("This session isn't in your plan any more");
		await expect(missing.getByRole('link', { name: 'Go to Today' })).toHaveAttribute(
			'href',
			'/today'
		);
		await expect(missing.getByRole('link', { name: 'Log a run' })).toHaveAttribute(
			'href',
			'/workout?new=run'
		);
		expect(await activeWorkout(page)).toBeNull();
		await audit(page, 'a missing session');
	});
});

test.describe('the kit held or unreachable', () => {
	test.use({ serviceWorkers: 'block' });

	test('while the kit is on its way: Getting your session ready, aria-busy, and nothing moves', async ({
		page
	}, testInfo) => {
		const { release, requests } = await holdKits(page);
		await page.goto(startUrl(strength()));
		await expect(loading(page)).toBeVisible();
		await expect(loading(page)).toHaveAttribute('aria-busy', 'true');
		await expect(loading(page)).toHaveAttribute('role', 'status');
		await expect(loading(page)).toContainText('Getting your session ready');
		await expect.poll(() => requests.length).toBe(1);

		await fontsLoaded(page);
		const watched = [loading(page), page.getByTestId('workout-header')];
		const before = [];
		for (const box of watched) before.push(await boxOf(box));
		await page.waitForTimeout(500);
		await fontsLoaded(page);
		for (const [i, box] of watched.entries()) {
			const after = await boxOf(box);
			for (const key of ['x', 'y', 'width', 'height'] as const) {
				expect(Math.abs(after[key] - before[i]![key]), `${key} of ${box}`).toBeLessThanOrEqual(1);
			}
		}
		const shift = await page.evaluate(() =>
			PerformanceObserver.supportedEntryTypes.includes('layout-shift')
				? performance
						.getEntriesByType('layout-shift')
						.reduce((sum, e) => sum + (e as unknown as { value: number }).value, 0)
				: 0
		);
		expect(shift, 'layout shift while starting').toBeLessThanOrEqual(0.01);

		await page.waitForLoadState('load');
		await captureScreen(page, testInfo, 'workout-start-loading');
		await audit(page, 'the loading state');

		release();
		await expect(page).toHaveURL(/\/workout$/);
		await expect(page.getByTestId('exercise').first()).toBeVisible();
	});

	test('offline with no saved kit: the designed message, with a session of your own instead', async ({
		page
	}, testInfo) => {
		await page.route(KIT_ROUTE, (route) => route.abort('internetdisconnected'));
		await page.goto(startUrl(strength()));
		const offline = page.getByTestId('workout-start-offline');
		await expect(offline).toContainText("This session isn't saved on this device");
		await expect(offline.getByRole('button', { name: 'Try again' })).toBeVisible();
		await expect(offline.getByRole('link', { name: 'Log a run' })).toHaveAttribute(
			'href',
			'/workout?new=run'
		);
		await expect(offline.getByRole('link', { name: 'Muay Thai or other' })).toHaveAttribute(
			'href',
			'/workout?new=other'
		);
		expect(await activeWorkout(page)).toBeNull();
		await captureScreen(page, testInfo, 'workout-start-offline');
		await audit(page, 'offline with no kit');
	});

	test('a kit saved earlier starts the session offline, and it syncs later', async ({ page }) => {
		// The empty screen's store creates the database; the kit is saved as Today saves it.
		await page.goto('/workout');
		await expect(page.locator('main#main[data-store]')).toBeAttached();
		const answer = await page.request.get(`/api/workouts/kit?lineage=${strength().lineage}`);
		expect(answer.status()).toBe(200);
		await saveKit(page, strength().lineage, (await answer.json()) as StartKit);

		await page.route('**/api/workouts/**', (route) => route.abort('internetdisconnected'));
		await page.goto(startUrl(strength()));
		await expect(page).toHaveURL(/\/workout$/);
		await expect(page.getByTestId('exercise').getByRole('heading', { level: 2 })).toHaveText(
			'Back squat'
		);
		const { id } = (await activeWorkout(page))!;
		await expect
			.poll(async () => (await readOutbox(page)).map((e) => e.envelope.type))
			.toEqual(['workout.start']);
		expect(await workoutRows(id)).toEqual([]);

		// Back online: the page's engine sends it.
		await page.unroute('**/api/workouts/**');
		await page.evaluate(() => window.dispatchEvent(new Event('online')));
		expect(await landed(page, id)).toMatchObject({ lineage: strength().lineage });
	});
});

test.describe('signed out', () => {
	test.use({ storageState: signedOut });

	test('Sign in to start this workout; after signing in, the URL returns and the session starts', async ({
		page
	}, testInfo) => {
		const url = startUrl(strength());
		await page.goto(url);
		const state = page.getByTestId('workout-start-signed-out');
		await expect(state).toContainText('Sign in to start this workout');
		const signIn = state.getByRole('link', { name: 'Sign in' });
		await expect(signIn).toHaveAttribute('href', `/?next=${encodeURIComponent(url)}`);
		expect(await activeWorkout(page).catch(() => null)).toBeNull();
		await captureScreen(page, testInfo, 'workout-start-signed-out');
		await audit(page, 'signed out');

		await signIn.click();
		await expect(page).toHaveURL(`/?next=${encodeURIComponent(url)}`);
		// Signed in (the passkey ceremony is auth.e2e's): the sign-in page returns to the start URL.
		const minted = await page.request.post('/api/test-support/session', { headers: SAME_ORIGIN });
		expect(minted.status()).toBe(200);
		await page.reload();
		await expect(page).toHaveURL(/\/workout$/);
		await expect(page.getByTestId('exercise').getByRole('heading', { level: 2 })).toHaveText(
			'Back squat'
		);
		const { id } = (await activeWorkout(page))!;
		expect(await landed(page, id)).toMatchObject({ lineage: strength().lineage });
	});
});

test.describe('ad hoc', () => {
	test('a run of your own starts from the empty workout screen, linked to no plan, in the profile’s units', async ({
		page
	}) => {
		// This device's display units differ from the training profile's: the profile's win.
		const { units } = (await (await page.request.get('/api/exercises')).json()) as {
			units: { weight: 'kg' | 'lb'; distance: 'km' | 'mi' };
		};
		const device = {
			units: units.weight === 'kg' ? 'lb' : 'kg',
			distance: units.distance === 'km' ? 'mi' : 'km'
		};
		await page.addInitScript((prefs) => {
			localStorage.setItem('pc:prefs:v1', JSON.stringify(prefs));
		}, device);
		await page.goto('/workout');
		const empty = page.getByTestId('workout-empty');
		await expect(empty.getByRole('link', { name: 'Muay Thai and other' })).toHaveAttribute(
			'href',
			'/workout?new=other'
		);
		await empty.getByRole('link', { name: 'Run' }).click();
		await expect(page).toHaveURL(/\/workout\/run$/);
		await expect(page.getByTestId('workout-header')).toContainText('Run');
		await expect(page.getByTestId('run-entry')).toBeVisible();
		const { id, kit } = (await activeWorkout(page))!;
		expect(kit).toMatchObject({
			kind: 'run',
			plannedSessionId: null,
			run: { segments: [] },
			units
		});
		expect(await landed(page, id)).toEqual({
			status: 'in_progress',
			lineage: null,
			session: null,
			session_lineage: null
		});
	});
});

test.describe('on a desktop window', () => {
	test.use({ ...DESKTOP, serviceWorkers: 'block' });

	test('every state centred at the readable width; the conflict sheet is a dialog with hover and focus states', async ({
		page
	}, testInfo) => {
		const { release } = await holdKits(page);
		await page.goto(startUrl(strength()));
		await expect(loading(page)).toBeVisible();
		await expectReadableAndCentred(page);
		release();
		await expect(page).toHaveURL(/\/workout$/);
		await expect(page.getByTestId('exercise').first()).toBeVisible();

		await page.goto(startUrl(run()));
		const dialog = page.getByRole('dialog', { name: 'Lower body & pull is in progress' });
		await expect(dialog).toBeVisible();
		// A dialog centred in the layout area (the window less the scrollbar gutter), not a bottom sheet.
		const box = await boxOf(sheet(page).locator('.sheet'));
		const window = page.viewportSize()!;
		expect(Math.abs(box.x + box.width / 2 - (await layoutWidth(page)) / 2)).toBeLessThanOrEqual(2);
		expect(box.y + box.height).toBeLessThan(window.height);

		const resume = page.getByTestId('start-resume');
		const discard = page.getByTestId('start-discard');
		for (const button of [resume, discard]) {
			expect((await boxOf(button)).height).toBeGreaterThanOrEqual(44);
			const background = () => button.evaluate((el) => getComputedStyle(el).backgroundColor);
			const resting = await background();
			await button.hover();
			await expect.poll(background).not.toBe(resting);
		}
		await page.mouse.move(0, 0);
		// By keyboard: Tab reaches both actions, each with a visible focus ring.
		let reached = 0;
		for (let i = 0; i < 6 && reached < 2; i++) {
			await page.keyboard.press('Tab');
			const focused = await page.evaluate(() =>
				document.activeElement?.getAttribute('data-testid')
			);
			if (focused === 'start-resume' || focused === 'start-discard') {
				reached++;
				const ring = await page.evaluate(() => {
					const el = document.activeElement as HTMLElement;
					return el.matches(':focus-visible') && getComputedStyle(el).outlineStyle !== 'none';
				});
				expect(ring, `${focused} shows its focus ring`).toBe(true);
			}
		}
		expect(reached).toBe(2);
		await captureScreen(page, testInfo, 'desktop-workout-start-conflict');
		await audit(page, 'the conflict sheet on a desktop');

		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expectReadableAndCentred(page);
		for (const width of [...DESKTOP_WIDTHS, BELOW_DESKTOP_WIDTH]) {
			await page.setViewportSize({ width, height: 900 });
			await expectNoSideScroll(page);
		}
	});

	test('the offline state sits at the readable width too, its actions with focus rings', async ({
		page
	}) => {
		await page.route(KIT_ROUTE, (route) => route.abort('internetdisconnected'));
		await page.goto(startUrl(strength()));
		const offline = page.getByTestId('workout-start-offline');
		await expect(offline).toBeVisible();
		await expectReadableAndCentred(page);
		await expectNoSideScroll(page);
		const adhocRun = offline.getByTestId('start-adhoc-run');
		await adhocRun.focus();
		expect(await adhocRun.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');
	});
});

test.describe('signed out, on a desktop window', () => {
	test.use({ ...DESKTOP, storageState: signedOut });

	test('Sign in to start this workout sits at the readable width', async ({ page }) => {
		await page.goto(startUrl(strength()));
		await expect(page.getByTestId('workout-start-signed-out')).toBeVisible();
		await expectReadableAndCentred(page);
		await expectNoSideScroll(page);
		const signIn = page.getByTestId('start-sign-in');
		await signIn.focus();
		expect(await signIn.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');
	});
});
