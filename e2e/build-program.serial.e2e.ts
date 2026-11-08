/**
 * Build my program on Today (src/routes/(app)/today/panels/Build.svelte and BuildPreview.svelte):
 * once onboarding is complete and there is no program, a Build card sits above the summary; it
 * runs the real generator on the owner's profile and previews the block timeline, week 1's
 * sessions, what week 1 is for and every decision with its why; Start week 1 stores version 1
 * and opens Train. The device's time zone (Auckland, pinned below) goes with both requests and
 * is recorded on the profile, so week 1's dates follow it. Pending, failed, offline, failed-chunk
 * and conflict states are designed. Serial: each test builds the one owner's training profile
 * through the app's own actions, and the last one leaves it blank again.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test';
import { addDays, mondayOf } from '../src/lib/domain/calendar';
import { localDay } from '../src/lib/domain/dates';
import {
	DESKTOP,
	expectInColumn,
	expectMainCentred,
	expectNoShift,
	expectNoSideScroll,
	tokenPx
} from './desktop';
import {
	captureScreen,
	gotoHydrated,
	profileAction,
	query,
	resetTrainingProfile,
	SAME_ORIGIN,
	trackConsoleErrors
} from './support';

const ZONE = 'Pacific/Auckland';
test.use({ timezoneId: ZONE });

/** Today in Auckland, as the server computes it from the zone the browser sends. */
const aucklandToday = () => localDay(new Date(), ZONE);
/** Week 1's first day for 'Next Monday': today when it is a Monday. */
function nextMonday(today: string): string {
	const monday = mondayOf(today);
	return monday === today ? today : addDays(monday, 7);
}

const general = (title: string, disciplines: string[]) => ({
	kind: 'general',
	title,
	disciplines,
	focus: title,
	measure: 'Train every planned week'
});

async function finishOnboarding(request: APIRequestContext) {
	const finish = await request.post('/onboarding/review?/complete', {
		headers: { ...SAME_ORIGIN, accept: 'application/json', 'x-sveltekit-action': 'true' },
		multipart: { payload: '{}' }
	});
	expect(await finish.json()).toMatchObject({ type: 'redirect', location: '/today' });
}

const SCHEDULE = {
	daysPerWeek: 5,
	availableDays: [],
	preferredTimes: [],
	sessionMinutes: 60,
	commitments: [
		{
			discipline: 'muay_thai',
			label: 'Muay Thai class',
			days: ['tue', 'thu'],
			timeOfDay: 'evening',
			durationMinutes: 90,
			intensity: 'hard'
		}
	]
};

/** A hybrid profile with blank 1RMs: strength, running and Muay Thai classes, then Finish. */
async function hybridProfile(request: APIRequestContext) {
	await profileAction(request, '/profile/goals?/saveGoal', general('Stay strong', ['strength']));
	await profileAction(request, '/profile/goals?/saveGoal', general('Run a 10k', ['running']));
	await profileAction(request, '/profile/goals?/saveGoal', general('Muay Thai', ['muay_thai']));
	await profileAction(request, '/profile/experience?/save', {
		entries: ['strength', 'running', 'muay_thai'].map((discipline) => ({
			discipline,
			level: 'intermediate'
		}))
	});
	await profileAction(request, '/profile/strength?/save', { unknown: true, lifts: [] });
	await profileAction(request, '/profile/schedule?/save', SCHEDULE);
	await finishOnboarding(request);
}

const card = (page: Page) => page.getByTestId('today-build');
const cta = (page: Page) => page.getByTestId('today-build-cta');
const liveCta = (page: Page) =>
	page.locator('[data-testid="today-build-cta"]:not([data-served] *)');
const preview = (page: Page) => page.getByTestId('build-preview');
const ready = (page: Page) => page.getByTestId('build-preview-ready');
const start = (page: Page) => page.getByTestId('build-start');
const notice = (page: Page) => page.getByTestId('build-notice');

/** Today's Build card is tapped and the preview is shown. */
async function openPreview(page: Page) {
	await gotoHydrated(page, '/today');
	await cta(page).click();
	await expect(ready(page)).toBeVisible({ timeout: 15_000 });
}

/** A form action of Today's, by name: `?/preview` or `?/build`. */
const action = (name: string) => (url: URL) =>
	url.pathname === '/today' && url.search === `?/${name}`;

async function audit(page: Page) {
	await page.waitForFunction(() => document.fonts.status === 'loaded');
	await page.waitForTimeout(400);
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
}

const programRows = () =>
	query<{ number: number; starts_on: string; first_planned_day: string; decisions: number }>(
		`select v.number, v.starts_on::text, v.first_planned_day::text,
		        (select count(*)::int from programming_decisions d where d.version_id = v.id) as decisions
		   from programs p join program_versions v on v.program_id = p.id`
	);

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test.afterEach(async ({ page }) => {
	await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test.afterAll(async () => {
	await resetTrainingProfile();
});

test('Build previews week 1 with its rationale, and Start week 1 stores version 1 in the device’s zone', async ({
	page,
	request
}, testInfo) => {
	test.setTimeout(90_000);
	const errors = trackConsoleErrors(page);
	await hybridProfile(request);
	await gotoHydrated(page, '/today');

	// The Build card sits above the summary, which is unchanged.
	await expect(card(page).getByRole('heading', { level: 2 })).toHaveText('Build my program');
	const cardBox = (await card(page).boundingBox())!;
	const goalsBox = (await page.getByTestId('today-goals').boundingBox())!;
	expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(goalsBox.y);
	await expect(page.getByTestId('today-goal')).toHaveCount(3);
	const target = (await cta(page).boundingBox())!;
	expect(target.height).toBeGreaterThanOrEqual(44);
	expect(await audit(page), 'card, dark').toEqual([]);
	await captureScreen(page, testInfo, 'today-build');

	await cta(page).click();
	await expect(ready(page)).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId('build-timeline').getByTestId('plan-block')).not.toHaveCount(0);
	expect(await page.getByTestId('build-session').count()).toBeGreaterThanOrEqual(3);
	await expect(page.getByTestId('build-session').first()).toBeVisible();
	await expect(page.getByTestId('build-week-purpose')).toContainText(/baseline/i);
	expect(await page.getByTestId('build-rationale-item').count()).toBeGreaterThanOrEqual(3);
	// Each why opens in place.
	const first = page.getByTestId('build-rationale-item').first();
	await first.locator('summary').click();
	await expect(first.locator('.why')).toBeVisible();
	const today = aucklandToday();
	await expect(preview(page)).toHaveAttribute('data-first-planned-day', nextMonday(today));
	expect(await audit(page), 'preview, dark').toEqual([]);
	await captureScreen(page, testInfo, 'today-build-preview');

	await start(page).click();
	await expect(page).toHaveURL('/train');
	await expect(page.getByTestId('program-position')).toContainText('Week 1 of');

	// The zone the device sent is the profile's now, and week 1's dates follow it.
	expect(await query('select time_zone from athlete_profiles')).toEqual([{ time_zone: ZONE }]);
	const rows = await programRows();
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		number: 1,
		starts_on: mondayOf(nextMonday(today)),
		first_planned_day: nextMonday(today)
	});
	expect(rows[0]!.decisions).toBeGreaterThan(3);

	// Today now shows the program state.
	await gotoHydrated(page, '/today');
	await expect(page.getByTestId('today-plan')).toBeVisible();
	await expect(card(page)).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('This week and Next Monday change week 1’s dates', async ({ page, request }) => {
	await hybridProfile(request);
	await openPreview(page);
	const today = aucklandToday();
	await expect(preview(page)).toHaveAttribute('data-first-planned-day', nextMonday(today));
	const choice = page.getByTestId('build-start-choice');
	await choice.getByRole('radio', { name: /This week/ }).check();
	await expect(preview(page)).toHaveAttribute('data-first-planned-day', today);
	await expect(ready(page)).toBeVisible();
	await choice.getByRole('radio', { name: /Next Monday/ }).check();
	await expect(preview(page)).toHaveAttribute('data-first-planned-day', nextMonday(today));
	await expect(ready(page)).toBeVisible();

	await choice.getByRole('radio', { name: /This week/ }).check();
	await expect(preview(page)).toHaveAttribute('data-first-planned-day', today);
	await start(page).click();
	await expect(page).toHaveURL('/train');
	expect(await programRows()).toMatchObject([
		{ starts_on: mondayOf(today), first_planned_day: today }
	]);
});

test('a profile edit before Start shows ‘Your profile changed’ over a refreshed preview', async ({
	page,
	request
}, testInfo) => {
	await hybridProfile(request);
	await openPreview(page);
	await profileAction(request, '/profile/schedule?/save', { ...SCHEDULE, sessionMinutes: 45 });
	await start(page).click();
	await expect(notice(page)).toContainText('Your profile changed');
	await expect(ready(page)).toBeVisible();
	expect(await programRows()).toEqual([]);
	expect(await audit(page), 'conflict, dark').toEqual([]);
	await captureScreen(page, testInfo, 'today-build-conflict');

	// The refreshed preview is what Start stores now.
	await start(page).click();
	await expect(page).toHaveURL('/train');
	expect(await programRows()).toHaveLength(1);
});

test('dumbbells only, a shoulder injury and a disliked landmine press leave the vertical press slot empty, under Left out', async ({
	page,
	request
}) => {
	await profileAction(request, '/profile/goals?/saveGoal', general('Get stronger', ['strength']));
	await profileAction(request, '/profile/schedule?/save', {
		daysPerWeek: 3,
		availableDays: [],
		preferredTimes: [],
		sessionMinutes: 60,
		commitments: []
	});
	await profileAction(request, '/profile/equipment?/save', {
		gymType: 'none',
		equipment: [],
		homeEquipment: ['dumbbells'],
		notes: null
	});
	await profileAction(request, '/profile/injuries?/save', {
		injuries: [
			{
				bodyArea: 'shoulder',
				side: 'left',
				severity: 'moderate',
				avoid: [],
				notes: null,
				active: true
			}
		]
	});
	await profileAction(request, '/profile/exercises?/save', {
		items: [{ exercise: 'Landmine press', sentiment: 'dislike' }]
	});
	await finishOnboarding(request);
	await openPreview(page);
	const leftOut = page.getByTestId('build-rationale-exclusions');
	await expect(leftOut.getByRole('heading', { level: 3 })).toHaveText('Left out');
	const empty = leftOut
		.getByTestId('build-rationale-item')
		.filter({ hasText: 'Nothing fits the main vertical push slot' });
	await expect(empty).toHaveCount(1);
	await empty.locator('summary').click();
	await expect(empty.locator('.why')).toContainText('The rest of the session goes ahead.');
});

test('in the light theme, the card and the preview pass axe', async ({ page, request }) => {
	await hybridProfile(request);
	await page.addInitScript(() =>
		localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: 'light' }))
	);
	await gotoHydrated(page, '/today');
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
	await expect(card(page)).toBeVisible();
	expect(await audit(page), 'card, light').toEqual([]);
	await cta(page).click();
	await expect(ready(page)).toBeVisible({ timeout: 15_000 });
	expect(await audit(page), 'preview, light').toEqual([]);
});

test.describe('with the service worker blocked, so page.route sees every request', () => {
	test.use({ serviceWorkers: 'block' });

	test('while the preview is planned, a skeleton holds its room (aria-busy), and nothing moves when it arrives', async ({
		page,
		request
	}) => {
		await hybridProfile(request);
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		await page.route(action('preview'), async (route) => {
			await held;
			await route.continue();
		});
		await gotoHydrated(page, '/today');
		await cta(page).click();
		const pending = page.getByTestId('build-preview-pending');
		await expect(pending).toHaveAttribute('aria-busy', 'true');
		await expect(ready(page)).toHaveCount(0);
		await page.waitForFunction(() => document.fonts.status === 'loaded');
		await expectNoShift(page, {
			boxes: [
				page.getByRole('heading', { level: 1, name: 'Today' }),
				page.getByRole('heading', { level: 2, name: 'Build my program' })
			],
			action: async () => {
				release();
				await expect(ready(page)).toBeVisible({ timeout: 15_000 });
			}
		});
		await expect(pending).toHaveCount(0);
	});

	test('a preview the server fails is a designed error with Retry, which recovers', async ({
		page,
		request
	}) => {
		await hybridProfile(request);
		let failing = true;
		await page.route(action('preview'), (route: Route) =>
			failing
				? route.fulfill({
						status: 500,
						contentType: 'application/json',
						body: JSON.stringify({ type: 'error', error: { message: 'Internal Error' } })
					})
				: route.continue()
		);
		await gotoHydrated(page, '/today');
		await cta(page).click();
		const failed = page.getByTestId('build-preview-error');
		await expect(failed).toContainText('Couldn’t plan week 1');
		await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
		const retry = failed.getByRole('button', { name: 'Retry' });
		expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
		expect(await audit(page), 'failed, dark').toEqual([]);
		failing = false;
		await retry.click();
		await expect(ready(page)).toBeVisible({ timeout: 15_000 });
		await expect(failed).toHaveCount(0);
	});

	test('with the preview’s code failing to load, Today’s panel Retry shows, and recovers', async ({
		page,
		request
	}) => {
		await hybridProfile(request);
		let failing = true;
		// Only BuildPreview's chunk carries its pending state's test id.
		await page.route('**/_app/immutable/**/*.js', async (route) => {
			const response = await route.fetch().catch(() => null);
			if (!response) return route.abort('internetdisconnected');
			const body = await response.text();
			if (body.includes('build-preview-pending') && failing) {
				return route.abort('internetdisconnected');
			}
			return route.fulfill({ response, body });
		});
		await gotoHydrated(page, '/today');
		await cta(page).click();
		const chunkError = page.getByTestId('today-panel-error');
		await expect(chunkError).toContainText('Couldn’t load this part of Today');
		failing = false;
		await chunkError.getByRole('button', { name: 'Retry' }).click();
		// WebKit fetches the module again in place; Chromium keeps the failed fetch and reloads
		// Today, where the Build card opens the preview again. The card stays mounted, hidden, while
		// the preview takes Today's place, so only one of the two is ever visible.
		const shown = ready(page).or(card(page)).filter({ visible: true });
		await expect(shown).toBeVisible({ timeout: 15_000 });
		// The reloaded card's served copy is inert, so click the live one.
		if (await card(page).isVisible()) {
			await liveCta(page).click();
		}
		await expect(ready(page)).toBeVisible({ timeout: 15_000 });
		await expect(card(page)).toBeHidden();
	});

	test('Start is busy while it is sent; offline, it is a designed error with Retry, and nothing is stored', async ({
		page,
		request,
		context
	}) => {
		await hybridProfile(request);
		await openPreview(page);

		await context.setOffline(true);
		await start(page).click();
		await expect(notice(page)).toContainText('You’re offline');
		await expect(notice(page)).toContainText('Nothing was saved');
		expect(await programRows()).toEqual([]);
		expect(await audit(page), 'offline, dark').toEqual([]);
		await context.setOffline(false);

		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		await page.route(action('build'), async (route) => {
			await held;
			await route.continue();
		});
		await notice(page).getByRole('button', { name: 'Retry' }).click();
		await expect(start(page)).toHaveAttribute('aria-busy', 'true');
		await expect(start(page)).toBeDisabled();
		release();
		await expect(page).toHaveURL('/train');
		expect(await programRows()).toHaveLength(1);
	});
});

test.describe('in a desktop window', () => {
	test.use(DESKTOP);

	test('the card and the preview sit in the readable column, Start at its foot, with hover states', async ({
		page,
		request
	}, testInfo) => {
		await hybridProfile(request);
		await gotoHydrated(page, '/today');
		await expectMainCentred(page, await tokenPx(page, '--content-readable'));
		const main = page.locator('main#main');
		const background = (el: ReturnType<typeof cta>) =>
			el.evaluate((node) => getComputedStyle(node).backgroundColor);
		const resting = await background(cta(page));
		await cta(page).hover();
		await expect.poll(() => background(cta(page))).not.toBe(resting);
		await captureScreen(page, testInfo, 'today-build-desktop');

		await cta(page).click();
		await expect(ready(page)).toBeVisible({ timeout: 15_000 });
		await expectMainCentred(page, await tokenPx(page, '--content-readable'));
		await expectNoSideScroll(page);
		await expectInColumn(page, start(page), main, []);
		const idle = await background(start(page));
		await start(page).hover();
		await expect.poll(() => background(start(page))).not.toBe(idle);
		await start(page).focus();
		await expect(start(page)).toBeFocused();
		await captureScreen(page, testInfo, 'today-build-preview-desktop');
	});
});
