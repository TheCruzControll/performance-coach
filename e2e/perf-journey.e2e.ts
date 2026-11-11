/**
 * The gym journey on a poor connection (performance council item 4): the perf specs throttle the
 * CPU only, so nothing measured launch, Today, Start, the first set and the tabs on a slow network
 * or on lie-fi (connected, nothing comes back). Each test runs on a device set up the night before
 * on a good network (the service worker installed and in control, today's kits saved by Today),
 * with M3's 'workout-day' program this week, then launches cold (every page closed, the worker
 * stopped) at 4× CPU:
 * - Slow: CDP network emulation at RTT_MS (300 ms) and 1.6 Mbps down, 750 kbps up, on the page.
 *   CDP's emulation does not reach the service worker's own fetches (a navigation it forwards),
 *   so those get the same round trip and transfer time by context.route, which reaches the
 *   worker's requests on Chromium.
 * - Lie-fi: every request that reaches the network is held, unanswered, until the test ends
 *   (context.route); what the precache serves never reaches it.
 * Every step's time is annotated: launch is from the navigation's start, the other steps from the
 * pointerdown of the tap. Gates, where the app promises not to wait on the network:
 * - the first set shows done in < 100 ms (pc:set-confirmed, M4 criterion 3), on both networks;
 * - on lie-fi, the launch at start_url shows the offline screen within the worker's navigation
 *   timeout (6 s, src/service-worker/index.ts) plus 3 s for the worker's start and the cached
 *   page at 4×, and Start is usable within its kit timeout (4 s, start.ts KIT_TIMEOUT_MS) plus 2
 *   s, from the kit Today saved; once the network is back, the set reaches Postgres exactly once.
 * The other steps wait on the server by design today (Today and the tabs are server-rendered;
 * council items 1, 7, 8 and 13), so they are measured, not gated, until CI has numbers to set
 * gates from; on lie-fi, each tab switch is given TAB_CAP_MS and its outcome is reported.
 */
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { markAt, ms, usableAt } from './launch';
import { PROGRAM_TZ, resetPrograms, seedProgram } from './program-support';
import { query, TABS } from './support';

const RTT_MS = 300;
/** 1.6 Mbps down and 750 kbps up, in bytes per ms. */
const DOWN_BYTES_PER_MS = 1_600_000 / 8 / 1000;
const UP_BYTES_PER_MS = 750_000 / 8 / 1000;
/** Tap to the frame that shows the set done (M4 criterion 3). */
const CONFIRM_MS = 100;
/** src/service-worker/index.ts NAVIGATION_TIMEOUT_MS: a navigation the network never answers. */
const NAVIGATION_TIMEOUT_MS = 6_000;
/** src/lib/client/workout/start.ts KIT_TIMEOUT_MS: Start's wait for a fresh kit. */
const KIT_TIMEOUT_MS = 4_000;
const OFFLINE_SCREEN_MS = NAVIGATION_TIMEOUT_MS + 3_000;
const LIEFI_START_MS = KIT_TIMEOUT_MS + 2_000;
/** How long a tab switch on lie-fi is watched for an answer. */
const TAB_CAP_MS = 10_000;
const STRENGTH = 'Lower body & pull';
/** Where a step's tap time is kept: a full navigation replaces the page's globals. */
const DOWN_KEY = 'pc-test:pointerdown';

let onboarded: Date | null = null;
test.beforeAll(async () => {
	const [profile] = await query<{ at: Date | null }>(
		'select onboarding_completed_at as at from athlete_profiles'
	);
	onboarded = profile?.at ?? null;
});
test.afterAll(async () => {
	await resetPrograms();
	await query('update athlete_profiles set onboarding_completed_at = $1', [onboarded]);
});

/** Each tap's time (epoch ms, the clock every document of the origin shares), kept per tab. */
function tapClock() {
	addEventListener(
		'pointerdown',
		(event) =>
			sessionStorage.setItem(
				'pc-test:pointerdown',
				String(performance.timeOrigin + event.timeStamp)
			),
		{ capture: true, passive: true }
	);
}

const todaySession = (page: Page) =>
	page.getByTestId('today-session').filter({ has: page.getByText(STRENGTH, { exact: true }) });
const startLink = (page: Page) => todaySession(page).getByTestId('start-workout');
const logger = (page: Page) => page.getByTestId('set-logger');
const nav = (page: Page) => page.getByRole('navigation', { name: 'Primary' });

/** The epoch time of the first frame `selector` matched a visible element with `text`, if given. */
const shownAt = (page: Page, selector: string, text: string | null, timeout = 30_000) =>
	page
		.waitForFunction(
			([css, wanted]) => {
				const el = [...document.querySelectorAll(css!)].find(
					(e) =>
						e.getClientRects().length > 0 && (wanted === null || !!e.textContent?.includes(wanted))
				);
				return el ? performance.timeOrigin + performance.now() : false;
			},
			[selector, text] as const,
			{ polling: 'raf', timeout }
		)
		.then((handle) => handle.jsonValue() as Promise<number>);

/** The epoch time of the last tap. */
const lastTap = async (page: Page) =>
	Number(await page.evaluate((key) => sessionStorage.getItem(key), DOWN_KEY));

/** The epoch time of the navigation's start. */
const origin = (page: Page) => page.evaluate(() => performance.timeOrigin);

/**
 * The device the night before, on a good network: Today loaded, its kits saved on the device, and
 * the service worker in control. Returns the strength session's start link.
 */
async function install(context: BrowserContext): Promise<string> {
	const page = await context.newPage();
	await page.goto('/today');
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
		timeout: 15_000
	});
	await expect(page.locator('[data-testid="today-plan"][data-kits="saved"]')).toBeAttached({
		timeout: 15_000
	});
	const href = (await startLink(page).getAttribute('href'))!;
	expect(href).toMatch(/^\/workout\?start=/);
	await page.close();
	return href;
}

/** A cold launch's page: the worker stopped, the CPU at 4× and, if given, the page's network. */
async function coldPage(context: BrowserContext, slow: boolean): Promise<Page> {
	const page = await context.newPage();
	const cdp = await context.newCDPSession(page);
	await cdp.send('ServiceWorker.enable');
	await cdp.send('ServiceWorker.stopAllWorkers');
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
	if (slow) {
		await cdp.send('Network.enable');
		await cdp.send('Network.emulateNetworkConditions', {
			offline: false,
			latency: RTT_MS,
			downloadThroughput: DOWN_BYTES_PER_MS * 1000,
			uploadThroughput: UP_BYTES_PER_MS * 1000
		});
	}
	return page;
}

/** The service worker's own fetches at the slow network's round trip and transfer time. */
async function slowWorker(context: BrowserContext) {
	await context.route('**/*', async (route) => {
		if (!route.request().serviceWorker()) return route.fallback();
		const sent = route.request().postDataBuffer()?.length ?? 0;
		const response = await route.fetch();
		const body = await response.body();
		const wait = RTT_MS + sent / UP_BYTES_PER_MS + body.length / DOWN_BYTES_PER_MS;
		await new Promise((done) => setTimeout(done, wait));
		await route.fulfill({ response, body });
	});
}

/** Lie-fi: every request that reaches the network held until `restore()` fails them. */
async function lieFi(context: BrowserContext) {
	const held: Route[] = [];
	await context.route('**/*', (route) => {
		held.push(route);
	});
	return {
		held: () => held.length,
		async restore() {
			await context.unrouteAll({ behavior: 'ignoreErrors' });
			for (const route of held) await route.abort('timedout').catch(() => {});
		}
	};
}

/** Completes the set at hand, with a weight if the logger has none: pc:set-confirmed, in ms. */
async function firstSet(page: Page): Promise<number> {
	const load = logger(page).getByTestId('logger-load');
	if (['', '0'].includes(await load.getByRole('spinbutton').inputValue()))
		await load.getByRole('button', { name: /^Increase / }).click();
	await logger(page).getByTestId('complete-set').click();
	await page.waitForFunction(() => performance.getEntriesByName('pc:set-confirmed').length > 0);
	return page.evaluate(() => performance.getEntriesByName('pc:set-confirmed')[0]!.duration);
}

/** Taps a tab and waits for its screen: tap to the frame that shows its heading, in ms. */
async function switchTab(page: Page, tab: (typeof TABS)[number], timeout = 30_000) {
	await nav(page).getByRole('link', { name: tab.label }).click();
	const shown = await shownAt(page, 'h1', tab.heading, timeout);
	await expect(page).toHaveURL(new RegExp(`${tab.path}$`));
	return shown - (await lastTap(page));
}

test.describe('the gym journey on a poor connection (4× CPU)', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'CPU and network emulation use CDP');
	test.describe.configure({ timeout: 240_000 });

	test.beforeEach(async ({ request }) => {
		await seedProgram(request, { fixture: 'workout-day', start: 'this_week' });
		await query('update athlete_profiles set onboarding_completed_at = now()');
	});

	test(`slow network (${RTT_MS} ms RTT, 1.6 Mbps): launch, Today, Start, the first set (< ${CONFIRM_MS} ms) and the tabs`, async ({
		browser
	}, testInfo) => {
		const context = await browser.newContext({ ...testInfo.project.use, timezoneId: PROGRAM_TZ });
		try {
			await context.addInitScript(tapClock);
			await install(context);
			await slowWorker(context);
			const page = await coldPage(context, true);
			const steps: string[] = [];

			await page.goto('/today', { waitUntil: 'commit' });
			const today =
				(await shownAt(page, '[data-testid="start-workout"]', 'Start workout')) -
				(await origin(page));
			steps.push(`launch to Today's Start ${ms(today)}`);

			await startLink(page).click();
			const usable = await usableAt(page, 30_000);
			const started = usable.epoch - (await lastTap(page));
			steps.push(`Start to a usable logger ${ms(started)}`);

			const confirmed = await firstSet(page);
			steps.push(`first set confirmed ${ms(confirmed)}`);

			await page.getByTestId('workout-header').getByRole('link', { name: 'Minimise' }).click();
			const back = (await shownAt(page, 'h1', 'Today')) - (await lastTap(page));
			steps.push(`Minimise to Today ${ms(back)}`);
			for (const tab of [...TABS.slice(1), TABS[0]!]) {
				steps.push(`${tab.label} ${ms(await switchTab(page, tab))}`);
			}

			testInfo.annotations.push({ type: 'slow network (ms)', description: steps.join(' · ') });
			expect(confirmed, 'the first set, on a slow network').toBeLessThan(CONFIRM_MS);
		} finally {
			await context.close();
		}
	});

	test(`lie-fi: the offline screen in ≤ ${OFFLINE_SCREEN_MS} ms, Start in ≤ ${LIEFI_START_MS} ms from the saved kit, the first set in < ${CONFIRM_MS} ms, synced once when the network is back`, async ({
		browser
	}, testInfo) => {
		const context = await browser.newContext({ ...testInfo.project.use, timezoneId: PROGRAM_TZ });
		try {
			await context.addInitScript(tapClock);
			const href = await install(context);
			const network = await lieFi(context);
			const page = await coldPage(context, false);
			const steps: string[] = [];

			// start_url: a server-rendered page the network never answers.
			await page.goto('/today', { waitUntil: 'commit' });
			const offline =
				(await shownAt(page, '[data-testid="offline-state"]', null, OFFLINE_SCREEN_MS + 5_000)) -
				(await origin(page));
			steps.push(`launch at /today to the offline screen ${ms(offline)}`);

			// The start link (the offline screen offers none yet: council item 1).
			// Start replaces the document (StartFlow.svelte), so time it from the first one's start.
			await page.goto(href, { waitUntil: 'commit' });
			const startedAt = await origin(page);
			const started = (await usableAt(page, LIEFI_START_MS + 5_000)).epoch - startedAt;
			steps.push(`/workout?start= to a usable logger ${ms(started)}`);
			const store = await markAt(page, 'pc:store-open');
			steps.push(`store-open ${ms(store)}`);

			const confirmed = await firstSet(page);
			steps.push(`first set confirmed ${ms(confirmed)}`);

			await page.getByTestId('workout-header').getByRole('link', { name: 'Minimise' }).click();
			const noAnswer = `no answer in ${TAB_CAP_MS} ms`;
			const back = await shownAt(page, 'h1', 'Today', TAB_CAP_MS)
				.then(async (at) => ms(at - (await lastTap(page))))
				.catch(() => noAnswer);
			steps.push(`Minimise to Today ${back}`);
			// The tab bar only shows once Today has.
			if (back !== noAnswer) {
				for (const tab of [...TABS.slice(1), TABS[0]!]) {
					const outcome = await switchTab(page, tab, TAB_CAP_MS)
						.then(ms)
						.catch(() => noAnswer);
					steps.push(`${tab.label} ${outcome}`);
				}
			}
			steps.push(`requests held ${network.held()}`);

			await network.restore();
			// Back online: the store flushes as /workout opens, and the set lands once.
			await page.goto('/workout');
			await expect
				.poll(
					async () =>
						(
							await query<{ workouts: number; sets: number }>(
								`select (select count(*)::int from workouts) as workouts,
								(select count(*)::int from set_records where deleted_at is null) as sets`
							)
						)[0],
					{ timeout: 30_000, message: 'one workout and its one set in Postgres' }
				)
				.toEqual({ workouts: 1, sets: 1 });

			testInfo.annotations.push({ type: 'lie-fi (ms)', description: steps.join(' · ') });
			expect(offline, 'start_url on lie-fi: the offline screen').toBeLessThanOrEqual(
				OFFLINE_SCREEN_MS
			);
			expect(started, 'Start on lie-fi, from the saved kit').toBeLessThanOrEqual(LIEFI_START_MS);
			expect(confirmed, 'the first set, on lie-fi').toBeLessThan(CONFIRM_MS);
		} finally {
			await context.close();
		}
	});
});
