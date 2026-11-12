/**
 * Today's state panels are code-split (src/routes/(app)/today/panels): the server sends the
 * state's panel as markup, which the browser keeps as sent while Today hydrates without its code,
 * and a client navigation shows Today at once with the panel's skeleton. These specs prove that the panel's code arriving late moves nothing,
 * on either path, and that a panel whose code fails to
 * load is a designed notice with Retry, in place of the panel only, which recovers once the
 * code can be fetched: in place where the browser fetches a failed module again (WebKit), or
 * through a reload of Today where it does not (Chromium). Serial: each test sets up the one
 * owner's training profile, and the last one leaves it blank again.
 */
import AxeBuilder from '@axe-core/playwright';
import {
	expect,
	test,
	type APIRequestContext,
	type APIResponse,
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

/** Only the Summary panel's chunk carries its schedule line's test id. */
const SUMMARY_MARKUP = 'today-schedule-summary';
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
	markup = SUMMARY_MARKUP
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
 * skeleton, and the setup card that replaces it moves nothing below it (This week).
 */
async function setupArrivesInPlace(page: Page) {
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
		boxes: [page.getByRole('heading', { level: 1, name: 'Today' }), week(page)],
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
	expect(
		Math.abs(card.height - reserved.height),
		'the card fills the skeleton’s room'
	).toBeLessThanOrEqual(1);
	await expectNoSideScroll(page);
}

const notice = (page: Page) => page.getByTestId('today-panel-error');
const goals = (page: Page) => page.getByTestId('today-goal');
/** This week's heading: under the summary (goals first), beside or under the state's panel. */
const week = (page: Page) => page.getByRole('heading', { level: 2, name: 'This week' });

async function audit(page: Page) {
	await page.waitForFunction(() => document.fonts.status === 'loaded');
	await page.waitForTimeout(400);
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
}

/** Arrive on Today with the Summary chunk failing, then let it through for Retry. */
async function arriveWithSummaryFailing(page: Page) {
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
		// Server-rendered, before its code: the goals and schedule are there, the countdown (which
		// the panel fills in once hydrated) still blank.
		await expect(goals(page)).toHaveCount(1);
		await expect(page.getByTestId('today-schedule-summary')).toHaveText(
			'4 days a week · 60 min sessions'
		);
		await expect.poll(() => requested, { message: 'the panel’s code is on its way' }).toBe(true);
		await page.waitForFunction(() => document.fonts.status === 'loaded');
		const countdown = page.getByTestId('today-goal-countdown');
		await expect(countdown).toBeVisible();
		await expect(countdown).not.toContainText('to go');
		// Today hydrates without the panel's code (its initial JS holds only what every state
		// shares): today's date is marked on the week strip while the chunk is still held.
		await expect(
			page.getByRole('list', { name: 'This week' }).locator('[aria-current="date"]')
		).toHaveCount(1);
		await expect(goals(page)).toHaveCount(1);

		await expectNoShift(page, {
			boxes: [
				page.getByTestId('today-goals'),
				page.getByTestId('today-schedule'),
				week(page),
				page.getByRole('heading', { level: 1, name: 'Today' })
			],
			action: async () => {
				release();
				await expect(countdown).toHaveText('10 weeks to go');
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
		// The held chunk does not hold the navigation: Today is there, its panel a skeleton.
		await expect(page).toHaveURL(/\/today$/);
		await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
		// The summary's, the last panel: the Build card's skeleton above it may still show.
		const skeleton = page.getByTestId('today-panel').last();
		await expect(skeleton).toHaveAttribute('aria-busy', 'true');
		await expect(goals(page)).toHaveCount(0);
		await expect.poll(() => requested, { message: 'the panel’s code is on its way' }).toBe(true);
		// The Build card above it is not held.
		await expect(page.getByTestId('today-build')).toBeVisible();
		const reserved = (await skeleton.boundingBox())!;
		expect(reserved.height, 'the skeleton holds the panel’s room').toBeGreaterThanOrEqual(
			24 * 16 - 1
		);
		await page.waitForFunction(() => document.fonts.status === 'loaded');

		// This week, under the summary (goals first), may move as the summary's actual height
		// replaces its skeleton's: on a client navigation only, below the fold on a phone, and not
		// worth reserving 24rem under a short summary.
		await expectNoShift(page, {
			boxes: [
				page.getByRole('heading', { level: 1, name: 'Today' }),
				page.getByTestId('today-build')
			],
			action: async () => {
				release();
				await expect(page.getByTestId('today-goal-countdown')).toHaveText('10 weeks to go');
			}
		});
		await expect(skeleton).toHaveCount(0);
		const panel = (await page.getByTestId('today-goals').boundingBox())!;
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

	test('a panel whose code fails is a designed notice with Retry, and Retry renders the panel', async ({
		page
	}, testInfo) => {
		const letThrough = await arriveWithSummaryFailing(page);
		const failed = notice(page);
		await expect(failed).toContainText('Couldn’t load this part of Today');
		await expect(goals(page)).toHaveCount(0);
		// Only the panel failed: the rest of Today is there and works.
		await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
		await expect(page.getByTestId('today-build')).toBeVisible();
		await expect(week(page)).toBeVisible();
		await expect(page.locator('body')).not.toContainText(/500|internal error/i);
		// It holds the panel's room: what is above it stays put once the panel arrives.
		const panel = page.getByTestId('today-panel');
		await expect(panel).toHaveAttribute('aria-busy', 'false');
		expect((await panel.boundingBox())!.height).toBeGreaterThanOrEqual(24 * 16 - 1);
		const retry = failed.getByRole('button', { name: 'Try again' });
		const target = (await retry.boundingBox())!;
		expect(target.width, 'Try again is at least 44 px wide').toBeGreaterThanOrEqual(44);
		expect(target.height, 'Try again is at least 44 px tall').toBeGreaterThanOrEqual(44);
		expect(await audit(page), 'dark').toEqual([]);
		await captureScreen(page, testInfo, 'today-panel-error');

		// Where the Build card above the panel sits in the document: Retry may scroll the page
		// (Chromium reloads it).
		const documentTop = async () =>
			(await page.getByTestId('today-build').boundingBox())!.y +
			(await page.evaluate(() => window.scrollY));
		const buildTop = await documentTop();
		letThrough();
		await retry.click();
		await expect(goals(page)).toHaveCount(1);
		await expect(page.getByTestId('today-goal-countdown')).toHaveText('10 weeks to go');
		await expect(notice(page)).toHaveCount(0);
		await expect(page.getByTestId('today-panel')).toHaveCount(0);
		expect(Math.abs((await documentTop()) - buildTop)).toBeLessThanOrEqual(1);
	});

	test('the notice is designed in the light theme too', async ({ page }) => {
		await page.addInitScript(() =>
			localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: 'light' }))
		);
		await arriveWithSummaryFailing(page);
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		expect(await audit(page), 'light').toEqual([]);
	});

	test.describe('in a desktop window', () => {
		test.use(DESKTOP);

		test('with setup incomplete, the setup card replaces its skeleton in place', async ({
			page
		}) => {
			await setupArrivesInPlace(page);
		});

		test('the notice sits in the wide column, and Retry has a hover state', async ({
			page
		}, testInfo) => {
			await arriveWithSummaryFailing(page);
			await expectMainCentred(page, await tokenPx(page, '--content-wide'));
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
