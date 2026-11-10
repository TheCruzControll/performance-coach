/**
 * The PRD §18 persistence cases M4's journeys leave open, on an iPhone viewport in both engines,
 * each with the mechanism it really uses (journey-offline.serial.e2e.ts covers network loss,
 * syncing, duplicates and failed-sync recovery):
 * 1. A real browser crash: the browser runs on a profile in its own temporary directory, and
 *    every process carrying that directory is killed with SIGKILL (persistence-support.ts crash),
 *    so no pagehide, unload or shutdown runs; context.close() would fire pagehide, so it is never
 *    the crash. Relaunched on the same profile, the workout resumes and syncs exactly once.
 * 2. A page closed while its sync request is held: reopened, the outbox replays.
 * 3. The network flapping while a backlog flushes, at counted requests, never on timers.
 * 4. An app update: a byte-different service worker installs mid-workout and takes over once the
 *    app is reopened, the workout intact throughout.
 * 5. A reload of /workout offline, on WebKit too.
 * Where an engine cannot do what a case needs, the case records the gap and its reason (an
 * annotation and a log line) instead of passing on a weaker mechanism. Every case prints its
 * counts and its mechanism. Each asserts only its own workout's rows, by client id. Serial: it
 * writes workouts of the one owner.
 */
import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { SYNC_URL } from '../src/lib/client/workout/sync';
import type { Mutation, StrengthKit, SyncRequest, SyncResponse } from '../src/lib/domain/workout';
import {
	adHoc,
	crash,
	firstExerciseSet,
	profile,
	serveOlderWorker,
	setsOf,
	workoutCount
} from './persistence-support';
import {
	gotoWorkout,
	injectMutation,
	readOutbox,
	readWorkout,
	seedWorkout,
	workoutDay
} from './workout-support';

let kit: StrengthKit;
/** The first exercise's planned sets: a set beyond them is an extra one, after Add a set. */
let planned: number;
test.beforeAll(async () => {
	kit = adHoc((await workoutDay()).strength);
	planned = kit.exercises[0]!.sets.length;
});

const rows = (page: Page) => page.getByTestId('workout-main').getByTestId('set');
const logger = (page: Page) => page.getByTestId('set-logger');
const heading = (page: Page) =>
	page.getByTestId('workout-main').getByTestId('exercise').getByRole('heading', { level: 2 });
const synced = (page: Page) => expect.poll(() => readOutbox(page), { timeout: 15_000 }).toEqual([]);

/** The outbox's set.log mutations, in order. */
const queuedSets = async (page: Page) =>
	(await readOutbox(page))
		.map((entry) => entry.envelope)
		.filter((m): m is Extract<Mutation, { type: 'set.log' }> => m.type === 'set.log');

/** Opens /workout against the real server, the store connected. */
async function open(page: Page) {
	await gotoWorkout(page, 'strength', { sync: 'real' });
	await expect(page.locator('main#main[data-store]')).toBeAttached();
}

/** A seeded workout whose start has synced, open on the page: its client id. */
async function syncedWorkout(page: Page) {
	const workoutId = await seedWorkout(page, kit);
	await open(page);
	await synced(page);
	expect(await workoutCount(workoutId)).toBe(1);
	return workoutId;
}

/** Logs sets `from` to `from + count - 1` of the first exercise with Complete set (Add a set first for an extra one). */
async function logSets(page: Page, count: number, from = 1) {
	for (let set = from; set < from + count; set += 1) {
		const extra = set > planned;
		if (extra) await page.getByTestId('add-set').click();
		await logger(page).getByTestId('complete-set').click();
		await expect(rows(page).nth(set - 1)).toHaveAttribute('data-state', extra ? 'extra' : 'done');
	}
}

/** The row states the first exercise shows after `count` sets. */
const statesAfter = (count: number) =>
	Array.from({ length: count }, (_, i) => (i < planned ? 'done' : 'extra'));

/** What a case printed: an annotation on the test and a line in the log. */
function report(testInfo: TestInfo, type: string, description: string) {
	testInfo.annotations.push({ type, description });
	console.log(`persistence-matrix [${testInfo.project.name}] ${type}: ${description}`);
}

/** Records an engine gap with its reason, then skips the rest of the case. */
function gap(testInfo: TestInfo, reason: string): never {
	report(testInfo, 'gap', reason);
	test.skip(true, reason);
	throw new Error('unreachable: test.skip throws');
}

/** The service worker registration's workers, by state. */
const workers = (page: Page) =>
	page.evaluate(async () => {
		const registration = await navigator.serviceWorker.getRegistration();
		return {
			installing: registration?.installing?.state ?? null,
			waiting: registration?.waiting?.state ?? null,
			active: registration?.active?.state ?? null
		};
	});

test.describe('a browser crash and reopen', () => {
	test('the browser is killed with SIGKILL after 3 sets online and 3 offline: relaunched on its profile, the workout resumes with its exercise, 6 sets and rest timer, and syncs exactly 6 rows', async ({
		playwright,
		browserName,
		launchOptions,
		baseURL,
		viewport,
		userAgent,
		deviceScaleFactor,
		isMobile,
		hasTouch,
		colorScheme
	}, testInfo) => {
		// Two browser launches and a crash: the default 30 s is too tight on a slow CI leg.
		test.slow();
		const browser = profile(playwright[browserName], {
			...launchOptions,
			baseURL,
			viewport,
			userAgent,
			deviceScaleFactor,
			isMobile,
			hasTouch,
			colorScheme,
			// The crash is the point here, not the precache; WebKit's page.route and offline
			// emulation need the worker blocked anyway (journey-offline.serial.e2e.ts).
			serviceWorkers: 'block'
		});
		try {
			let context = await browser.launch();
			let page = context.pages()[0] ?? (await context.newPage());
			const workoutId = await syncedWorkout(page);

			await logSets(page, 3);
			await synced(page);
			expect(await setsOf(workoutId)).toHaveLength(3);
			await context.setOffline(true);
			await page.waitForFunction(() => !navigator.onLine);
			await logSets(page, 3, 4);
			// Written to IndexedDB, rest timer included, before the crash.
			await expect.poll(async () => (await queuedSets(page)).length).toBe(3);
			const exercise = (await heading(page).textContent())!.trim();
			const record = (await readWorkout(page, workoutId)) as { device: { rest: unknown } };
			expect(record.device.rest, 'the 6th set started the rest timer').not.toBeNull();
			await expect(page.getByTestId('rest-timer')).toBeVisible();

			const killed = await crash(context, browser.dir);
			if (killed.length === 0) {
				await context.close();
				const reason = `no ${browserName} process carries the profile directory on its command line, so it cannot be killed by it`;
				expect(browserName, reason).toBe('webkit');
				gap(testInfo, reason);
			}

			context = await browser.launch();
			page = context.pages()[0] ?? (await context.newPage());
			await open(page);
			await expect(heading(page)).toHaveText(exercise);
			await expect(rows(page)).toHaveCount(6);
			for (const [i, state] of statesAfter(6).entries()) {
				await expect(rows(page).nth(i)).toHaveAttribute('data-state', state);
			}
			await expect(page.getByTestId('rest-timer')).toBeVisible();
			const reopened = (await readWorkout(page, workoutId)) as { device: { rest: unknown } };
			expect(reopened.device.rest, 'the same rest, from its timestamps').toEqual(
				record.device.rest
			);

			await synced(page);
			const sets = await setsOf(workoutId);
			expect(sets.map((s) => [s.set_index, s.deleted])).toEqual(
				[1, 2, 3, 4, 5, 6].map((i) => [i, false])
			);
			expect(new Set(sets.map((s) => s.id)).size).toBe(6);
			expect(await workoutCount(workoutId)).toBe(1);
			report(
				testInfo,
				'crash',
				`SIGKILL to ${killed.length} process(es) whose command line carries the profile directory (not CDP Browser.crash); after the relaunch: 6 sets on screen, the rest timer restored, ${sets.length} rows`
			);
			await context.close();
		} finally {
			browser.remove();
		}
	});
});

test.describe('the network during a sync', () => {
	// Held, dropped and failed requests are page routes: on WebKit only without a service worker.
	test.use({ serviceWorkers: 'block' });

	test('a page closed while its sync request is held: reopened, the sets replay, one row per set', async ({
		page,
		context
	}, testInfo) => {
		const workoutId = await syncedWorkout(page);
		/** Every sync request the closing page sent, held unanswered: their mutation counts. */
		const held: number[] = [];
		await context.route(`**${SYNC_URL}`, (route) => {
			held.push((route.request().postDataJSON() as SyncRequest).mutations.length);
		});

		await logSets(page, 2);
		await expect.poll(async () => (await queuedSets(page)).length).toBe(2);
		await expect.poll(() => held.length).toBeGreaterThan(0);
		const logs = await queuedSets(page);
		// Closing fires pagehide, whose keepalive send goes to the same route; a browser may still
		// deliver it once the page is gone, so the replay is proven by the reopened page's request.
		await page.close();
		const beforeReopen = (await setsOf(workoutId)).length;

		await context.unrouteAll({ behavior: 'ignoreErrors' });
		/** The reopened page's sync requests, by their set.log ids: the replay, whatever landed first. */
		const replayed: string[][] = [];
		await context.route(`**${SYNC_URL}`, (route) => {
			const { mutations } = route.request().postDataJSON() as SyncRequest;
			replayed.push(mutations.filter((m) => m.type === 'set.log').map((m) => m.id));
			return route.continue();
		});
		const reopened = await context.newPage();
		await open(reopened);
		await synced(reopened);
		expect(replayed[0], 'the reopened page resent both sets').toEqual(logs.map((log) => log.id));
		const sets = await setsOf(workoutId);
		expect(sets.map((s) => [s.id, s.set_index, s.deleted])).toEqual(
			logs.map((log, i) => [log.entityId, i + 1, false])
		);
		expect(await workoutCount(workoutId)).toBe(1);
		report(
			testInfo,
			'closed mid-sync',
			`${held.length} request(s) held while the page closed (${held.join(', ')} changes), ${beforeReopen} rows before reopening, ${replayed.length} replay request(s), ${sets.length} rows after`
		);
		await reopened.close();
	});

	test('the network drops at 10 counted steps of a 20-set flush, before and after the server commits: 20 rows in order, none duplicated', async ({
		page,
		context
	}, testInfo) => {
		// Ten drops and ten reconnects, each waited for.
		test.slow();
		const workoutId = await syncedWorkout(page);
		const sets = Array.from({ length: 20 }, (_, i) => firstExerciseSet(kit, workoutId, i + 1));
		/** The sets queued offline before the flush; the rest are logged while it is under way. */
		const BACKLOG = 4;
		/** Logged while each of the first dropped requests is out, so the next batch carries them too. */
		const PER_DROP = 2;
		const FLAPS = 10;
		await context.setOffline(true);
		await page.waitForFunction(() => !navigator.onLine);
		for (const set of sets.slice(0, BACKLOG)) await injectMutation(page, set);
		let queued = BACKLOG;

		/** Each request's size, and every answer the server gave with what it had committed before. */
		const batches: number[] = [];
		const answers: { id: string; status: string; committedBefore: boolean }[] = [];
		const committed = new Set<string>();
		let dropped = 0;
		await context.route(`**${SYNC_URL}`, async (route) => {
			const { mutations } = route.request().postDataJSON() as SyncRequest;
			batches.push(mutations.length);
			// Counted requests, alternately dropped before and after the server commits.
			const when = dropped >= FLAPS ? null : dropped % 2 === 0 ? 'before commit' : 'after commit';
			if (when) {
				for (let i = 0; i < PER_DROP && queued < sets.length; i += 1) {
					await injectMutation(page, sets[queued++]!);
				}
			}
			if (when === 'before commit') return drop(route);
			const response = await route.fetch();
			const { results } = (await response.json()) as SyncResponse;
			for (const { id, status } of results) {
				answers.push({ id, status, committedBefore: committed.has(id) });
			}
			for (const { id } of results) committed.add(id);
			if (when === 'after commit') return drop(route);
			return route.fulfill({ response });
		});
		/** The network goes, the request with it; once the page has seen it, it comes back. */
		async function drop(route: Route) {
			dropped += 1;
			await route.abort('internetdisconnected');
			await context.setOffline(true);
			await page.waitForFunction(() => !navigator.onLine);
			await context.setOffline(false);
		}

		await context.setOffline(false);
		await expect.poll(() => dropped, { timeout: 30_000 }).toBe(FLAPS);
		expect(queued).toBe(sets.length);
		await synced(page);

		const rowsNow = await setsOf(workoutId);
		expect(rowsNow.map((s) => [s.id, s.set_index, s.deleted])).toEqual(
			sets.map((set, i) => [set.entityId, i + 1, false])
		);
		expect(await workoutCount(workoutId)).toBe(1);
		const ids = (status: string) => answers.filter((a) => a.status === status).map((a) => a.id);
		expect(ids('applied'), 'applied once each, in outbox order').toEqual(sets.map((s) => s.id));
		expect(
			answers.filter((a) => (a.status === 'duplicate') !== a.committedBefore),
			'duplicate exactly for the resends of sets already committed'
		).toEqual([]);
		expect(Math.max(...batches), 'later batches carry the backlog together').toBe(sets.length);
		expect(ids('duplicate').length).toBeGreaterThan(0);
		report(
			testInfo,
			'network flaps',
			`context.setOffline at ${dropped} counted requests (${FLAPS / 2} before the commit, ${FLAPS / 2} after); batches of ${batches.join(', ')} sets; ${ids('applied').length} applied, ${ids('duplicate').length} duplicate answers, ${rowsNow.length} rows`
		);
	});
});

test.describe('an app update mid-workout', () => {
	// The service worker is the point here: allowed on both engines.
	test.use({ serviceWorkers: 'allow' });

	test('a byte-different service worker installs mid-workout: the workout stays intact, and once the app is reopened the new worker is active and the workout carries on', async ({
		page,
		context,
		browserName
	}, testInfo) => {
		test.slow();
		// The worker that installs first is the deployment before this one; the server's own
		// script, byte-different, is the update.
		const served = await serveOlderWorker(context);
		const workoutId = await syncedWorkout(page);
		await expect
			.poll(async () => (await workers(page)).active, { timeout: 15_000 })
			.toBe('activated');
		if (served() === 0) {
			const reason = `${browserName}'s service worker script fetch never reached context.route, so no byte-different worker could be installed first`;
			expect(browserName, reason).toBe('webkit');
			gap(testInfo, reason);
		}
		await logSets(page, 2);
		await synced(page);
		const exercise = (await heading(page).textContent())!.trim();

		const failed = await page.evaluate(async () => {
			const registration = await navigator.serviceWorker.ready;
			return registration.update().then(
				() => null,
				(error: unknown) => String(error)
			);
		});
		expect(failed).toBeNull();
		await expect
			.poll(async () => (await workers(page)).waiting, { timeout: 15_000 })
			.toBe('installed');

		// Mid-workout the page keeps its worker, and the workout goes on.
		for (const [i, state] of statesAfter(2).entries()) {
			await expect(rows(page).nth(i)).toHaveAttribute('data-state', state);
		}
		await logSets(page, 1, 3);
		await synced(page);

		// The app is left and opened again: with no page left on the old worker, the new one
		// activates. A navigation that reached the old worker before it let go is opened again
		// (counted, at most three times).
		let opens = 0;
		do {
			opens += 1;
			await page.goto('about:blank');
			await open(page);
		} while ((await workers(page)).waiting !== null && opens < 3);
		await expect
			.poll(() => workers(page), { timeout: 15_000 })
			.toEqual({ installing: null, waiting: null, active: 'activated' });
		await expect(heading(page)).toHaveText(exercise);
		for (const [i, state] of statesAfter(3).entries()) {
			await expect(rows(page).nth(i)).toHaveAttribute('data-state', state);
		}
		await logSets(page, 1, 4);
		await synced(page);
		const sets = await setsOf(workoutId);
		expect(sets.map((s) => [s.set_index, s.deleted])).toEqual([1, 2, 3, 4].map((i) => [i, false]));
		report(
			testInfo,
			'app update',
			`context.route served the first install's script ${served()} time(s) with a comment appended, the update check the server's own; the new worker installed mid-workout and was active after ${opens} reopen(s); ${sets.length} rows`
		);
	});
});

test.describe('an offline reload', () => {
	// Chromium keeps its service worker for the reload offline; WebKit blocks it (see the test).
	test.use({
		serviceWorkers: async ({ browserName }, use) =>
			use(browserName === 'chromium' ? 'allow' : 'block')
	});

	test('a reload of /workout offline restores the workout from IndexedDB, and reconnecting syncs it once', async ({
		page,
		context,
		browserName
	}, testInfo) => {
		const workoutId = await syncedWorkout(page);
		const withWorker = browserName === 'chromium';
		if (withWorker) {
			await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
				timeout: 15_000
			});
		}
		await logSets(page, 2);
		await synced(page);
		const exercise = (await heading(page).textContent())!.trim();

		if (withWorker) {
			await context.setOffline(true);
			await page.waitForFunction(() => !navigator.onLine);
		} else {
			report(
				testInfo,
				'gap',
				"Playwright's offline emulation does not reach WebKit's service worker, so WebKit reloads without it and with every /api request aborted: the IndexedDB restore is proven, the precached offline shell only on Chromium"
			);
			await page.route('**/api/**', (route) => route.abort('internetdisconnected'));
		}
		await logSets(page, 1, 3);
		await expect.poll(async () => (await queuedSets(page)).length).toBe(1);

		await page.reload();
		await expect(page.locator('main#main[data-store]')).toBeAttached();
		await expect(heading(page)).toHaveText(exercise);
		for (const [i, state] of statesAfter(3).entries()) {
			await expect(rows(page).nth(i)).toHaveAttribute('data-state', state);
		}
		expect(await queuedSets(page)).toHaveLength(1);
		expect(await setsOf(workoutId), 'the offline set stayed on the device').toHaveLength(2);

		if (withWorker) {
			await context.setOffline(false);
		} else {
			await page.unroute('**/api/**');
			// The network is back: what 'online' does, at once.
			await page.evaluate(() => window.dispatchEvent(new Event('online')));
		}
		await synced(page);
		const sets = await setsOf(workoutId);
		expect(sets.map((s) => [s.set_index, s.deleted])).toEqual([1, 2, 3].map((i) => [i, false]));
		report(
			testInfo,
			'offline reload',
			`${withWorker ? 'context.setOffline, the precached /workout' : 'every /api request aborted, no service worker'}; 3 sets restored, ${sets.length} rows after reconnecting`
		);
	});
});
