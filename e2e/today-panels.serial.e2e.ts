/**
 * Today's state panels are code-split (src/routes/(app)/today/panels): the server sends the
 * state's panel as markup, which the browser keeps as sent while Today hydrates without its code,
 * and a client navigation shows Today at once with the panel's room, 'Getting today' (here the
 * Build card's, the panel of an owner set up with no program). These specs prove that the panel's code
 * arriving late moves nothing, on either path, and that a panel whose code fails to load is a
 * designed statement with Try again, in place of the panel only, which recovers once the code can be
 * fetched: in place where the browser fetches a failed module again (WebKit), or through a
 * reload of Today where it does not (Chromium). Serial: each test sets up the one owner's
 * training profile, and the last one leaves it blank again.
 */
import AxeBuilder from '@axe-core/playwright';
import {
	expect,
	test,
	type APIRequestContext,
	type APIResponse,
	type Locator,
	type Page,
	type Route
} from '@playwright/test';
import { DESKTOP, expectMainCentred, expectNoShift, expectNoSideScroll, tokenPx } from './desktop';
import {
	captureScreen,
	gotoHydrated,
	profileAction,
	resetTrainingProfile,
	SAME_ORIGIN
} from './support';

/**
 * Only the Build panel's chunk carries its badge's words. Not its test id: the card passes it to
 * Card as a prop, so the chunk never holds `data-testid="today-build"`.
 */
const BUILD_MARKUP = 'Profile ready';
/** Only the Setup panel's chunk carries its step count's test id. */
const SETUP_MARKUP = 'today-setup-count';

/** The device's date `days` from now, as a stored calendar date (the browser shares its zone). */
function inDays(days: number): string {
	const d = new Date();
	d.setDate(d.getDate() + days);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Onboarding finished through the app's own actions: a fight ten weeks out, a schedule, Finish. */
async function setUp(request: APIRequestContext) {
	await profileAction(request, '/profile/goals?/saveGoal', {
		kind: 'event',
		title: 'First Muay Thai fight',
		disciplines: ['muay_thai'],
		eventType: 'Muay Thai fight',
		eventDate: inDays(70)
	});
	await profileAction(request, '/profile/schedule?/save', {
		daysPerWeek: 4,
		availableDays: ['mon', 'tue', 'thu', 'sat'],
		preferredTimes: [],
		sessionMinutes: 60,
		commitments: []
	});
	const finish = await request.post('/onboarding/review?/complete', {
		headers: { ...SAME_ORIGIN, accept: 'application/json', 'x-sveltekit-action': 'true' },
		multipart: { payload: '{}' }
	});
	expect(await finish.json()).toMatchObject({ type: 'redirect', location: '/today' });
}

/**
 * Serve the app's scripts, handing each request for the panel chunk carrying `markup` to `panel`.
 */
async function routePanelChunk(
	page: Page,
	panel: (route: Route, response: APIResponse) => Promise<void>,
	markup = BUILD_MARKUP
) {
	await page.route('**/_app/immutable/**/*.js', async (route) => {
		const response = await route.fetch().catch(() => null);
		if (!response) return route.abort('internetdisconnected');
		const body = await response.text();
		if (!body.includes(markup)) return route.fulfill({ response, body });
		await panel(route, response);
	});
}

/**
 * With onboarding incomplete, go from Profile to Today with the Setup chunk held: Today shows its
 * room, and the setup card that replaces it moves nothing (the date line above it). On a phone the
 * card fills its room; at a desk nothing sits under it in its column, so it takes its own height
 * there, never more than the room.
 */
async function setupArrivesInPlace(page: Page, room: 'fills' | 'own' = 'fills') {
	await resetTrainingProfile();
	let release = () => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	let requested = false;
	await routePanelChunk(
		page,
		async (route, response) => {
			requested = true;
			await held;
			await route.fulfill({ response });
		},
		SETUP_MARKUP
	);
	await gotoHydrated(page, '/profile');
	await page.getByRole('link', { name: 'Today' }).first().click();
	await expect(page).toHaveURL(/\/today$/);
	const skeleton = page.getByTestId('today-panel');
	await expect(skeleton).toHaveAttribute('aria-busy', 'true');
	await expect(page.getByTestId('today-setup')).toHaveCount(0);
	await expect.poll(() => requested, { message: 'the setup card’s code is on its way' }).toBe(true);
	const reserved = (await skeleton.boundingBox())!;
	await page.waitForFunction(() => document.fonts.status === 'loaded');

	await expectNoShift(page, {
		boxes: [dateLine(page)],
		action: async () => {
			release();
			await expect(page.getByTestId('today-setup-count')).toHaveText('0 of 10 steps done');
		}
	});
	await expect(skeleton).toHaveCount(0);
	const card = (await page.getByTestId('today-setup').boundingBox())!;
	expect(
		Math.abs(card.y - reserved.y),
		'the card starts where its skeleton did'
	).toBeLessThanOrEqual(1);
	if (room === 'fills')
		expect(
			Math.abs(card.height - reserved.height),
			'the card fills the skeleton’s room'
		).toBeLessThanOrEqual(1);
	else
		expect(card.height, 'the card fits in the skeleton’s room').toBeLessThanOrEqual(
			reserved.height + 1
		);
	await expectNoSideScroll(page);
}

const notice = (page: Page) => page.getByTestId('today-panel-error');
/** The date line above the state's panel (no week before a program, v2/06b). */
const dateLine = (page: Page) => page.getByTestId('today-date');
/** The Build card's live button, not its served copy (inert until the card's code arrives). */
const buildCta = (page: Page) =>
	page.locator('[data-testid="today-build-cta"]:not([data-served] *)');

async function audit(page: Page) {
	await page.waitForFunction(() => document.fonts.status === 'loaded');
	await page.waitForTimeout(400);
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
}

/** Arrive on Today with the Build chunk failing, then let it through for Retry. */
async function arriveWithBuildFailing(page: Page) {
	let failing = true;
	await routePanelChunk(page, async (route, response) => {
		if (failing) await route.abort('internetdisconnected');
		else await route.fulfill({ response });
	});
	await gotoHydrated(page, '/today');
	await expect(notice(page)).toBeVisible();
	return () => (failing = false);
}

test.beforeEach(async ({ request }) => {
	await resetTrainingProfile();
	await setUp(request);
});

test.afterEach(async ({ page }) => {
	await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test.afterAll(async () => {
	await resetTrainingProfile();
});

test.describe('with the service worker blocked, so page.route sees every chunk', () => {
	test.use({ serviceWorkers: 'block' });

	test('the panel’s code arriving late holds nothing up and moves nothing: the server’s markup holds its place', async ({
		page
	}) => {
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		let requested = false;
		await routePanelChunk(page, async (route, response) => {
			requested = true;
			await held;
			await route.fulfill({ response });
		});
		// Not waiting for the load event, which the held chunk could delay.
		await page.goto('/today', { waitUntil: 'domcontentloaded' });
		// Server-rendered, before its code: the Build card is there, its button the served copy.
		await expect(page.getByTestId('today-build')).toBeVisible();
		await expect(page.getByTestId('today-build-cta')).toHaveText('Build my program');
		await expect.poll(() => requested, { message: 'the panel’s code is on its way' }).toBe(true);
		await page.waitForFunction(() => document.fonts.status === 'loaded');
		await expect(buildCta(page)).toHaveCount(0);
		// Today hydrates without the panel's code (its initial JS holds only what every state
		// shares): the device's date is on the top line while the chunk is still held.
		await expect(dateLine(page)).toHaveText(/^\w+day \d{1,2} \w+$/);
		await expect(buildCta(page)).toHaveCount(0);

		await expectNoShift(page, {
			boxes: [page.getByTestId('today-build'), dateLine(page)],
			action: async () => {
				release();
				await expect(buildCta(page)).toBeVisible();
			}
		});
		await expect(page.getByTestId('today-panel')).toHaveCount(0);
	});

	test('on a client navigation, Today shows at once with the panel’s skeleton, which the panel replaces in place', async ({
		page
	}) => {
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		let requested = false;
		await routePanelChunk(page, async (route, response) => {
			requested = true;
			await held;
			await route.fulfill({ response });
		});
		await gotoHydrated(page, '/profile');
		await page.getByRole('link', { name: 'Today' }).first().click();
		// The held chunk does not hold the navigation: Today is there, its panel's room 'Getting today'.
		await expect(page).toHaveURL(/\/today$/);
		await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
		const skeleton = page.getByTestId('today-panel');
		await expect(skeleton).toHaveAttribute('aria-busy', 'true');
		await expect(skeleton).toContainText('Getting today');
		await expect(page.getByTestId('today-build')).toHaveCount(0);
		await expect.poll(() => requested, { message: 'the panel’s code is on its way' }).toBe(true);
		const reserved = (await skeleton.boundingBox())!;
		expect(reserved.height, 'the skeleton holds the panel’s room').toBeGreaterThanOrEqual(
			17 * 16 - 1
		);
		await page.waitForFunction(() => document.fonts.status === 'loaded');

		await expectNoShift(page, {
			boxes: [dateLine(page)],
			action: async () => {
				release();
				await expect(buildCta(page)).toBeVisible();
			}
		});
		await expect(skeleton).toHaveCount(0);
		const panel = (await page.getByTestId('today-build').boundingBox())!;
		expect(
			Math.abs(panel.y - reserved.y),
			'the panel starts where its skeleton did'
		).toBeLessThanOrEqual(1);
	});

	test('with setup incomplete, the setup card replaces its skeleton in place after a client navigation', async ({
		page
	}) => {
		await setupArrivesInPlace(page);
	});

	test('a panel whose code fails is a designed statement with Try again, which renders the panel', async ({
		page
	}, testInfo) => {
		const letThrough = await arriveWithBuildFailing(page);
		const failed = notice(page);
		await expect(failed.getByRole('heading', { level: 2 })).toHaveText('Couldn’t load today');
		await expect(failed).toContainText('Everything else here still works.');
		await expect(page.getByTestId('today-build')).toHaveCount(0);
		// Only the panel failed: the rest of Today is there and works.
		await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeAttached();
		await expect(dateLine(page)).toBeVisible();
		await expect(page.getByTestId('today-avatar')).toBeVisible();
		await expect(page.locator('body')).not.toContainText(/500|internal error/i);
		// It holds the panel's room: what is above it stays put once the panel arrives.
		const panel = page.getByTestId('today-panel');
		await expect(panel).toHaveAttribute('aria-busy', 'false');
		expect((await panel.boundingBox())!.height).toBeGreaterThanOrEqual(17 * 16 - 1);
		const retry = failed.getByRole('button', { name: 'Try again' });
		const target = (await retry.boundingBox())!;
		expect(target.width, 'Try again is at least 44 px wide').toBeGreaterThanOrEqual(44);
		expect(target.height, 'Try again is at least 44 px tall').toBeGreaterThanOrEqual(44);
		expect(await audit(page), 'dark').toEqual([]);
		await captureScreen(page, testInfo, 'today-panel-error');

		// Where the notice sits in the document: Retry may scroll the page (Chromium reloads it).
		// The Build card arrives where the notice was. The live card, not its served copy: after
		// the reload the copy shows first and is replaced once the card mounts, which leaves a box
		// read from it null.
		const documentTop = async (target: Locator) =>
			(await target.boundingBox())!.y + (await page.evaluate(() => window.scrollY));
		const noticeTop = await documentTop(panel);
		letThrough();
		await retry.click();
		await expect(buildCta(page)).toBeVisible();
		await expect(notice(page)).toHaveCount(0);
		await expect(page.getByTestId('today-panel')).toHaveCount(0);
		const card = page.locator('[data-testid="today-build"]:not([data-served] *)');
		expect(Math.abs((await documentTop(card)) - noticeTop)).toBeLessThanOrEqual(1);
	});

	test('the notice is designed in the light theme too', async ({ page }) => {
		await page.addInitScript(() =>
			localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: 'light' }))
		);
		await arriveWithBuildFailing(page);
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		expect(await audit(page), 'light').toEqual([]);
	});

	test.describe('in a desktop window', () => {
		test.use(DESKTOP);

		test('with setup incomplete, the setup card replaces its skeleton in place', async ({
			page
		}) => {
			await setupArrivesInPlace(page, 'own');
		});

		test('the statement sits in the readable column, and Try again has a hover state', async ({
			page
		}, testInfo) => {
			await arriveWithBuildFailing(page);
			await expectMainCentred(page, await tokenPx(page, '--content-readable'));
			await expectNoSideScroll(page);
			const main = (await page.locator('main#main').boundingBox())!;
			const box = (await notice(page).boundingBox())!;
			expect(box.x).toBeGreaterThanOrEqual(main.x - 1);
			expect(box.x + box.width).toBeLessThanOrEqual(main.x + main.width + 1);
			const retry = notice(page).getByRole('button', { name: 'Try again' });
			const background = () => retry.evaluate((el) => getComputedStyle(el).backgroundColor);
			const resting = await background();
			await retry.hover();
			await expect.poll(background).not.toBe(resting);
			await retry.focus();
			await expect(retry).toBeFocused();
			await captureScreen(page, testInfo, 'today-panel-error-desktop');
		});
	});
});
