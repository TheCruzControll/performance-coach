/**
 * Today in a desktop window (docs/design-system.md, Responsive layout → Screens): a wide screen.
 * The week runs across the top; the state's panel (the setup card, the Build card, Build my
 * program, or today's plan) takes the main column, and the goals, then This week, take the side
 * column (the plate calculator lives in Train and the workout, not on Today). Every designed state keeps that frame: setup, ready, the program (a session
 * day, a rest day, starting Monday, the first block complete), a failed read, offline, a panel
 * whose code fails, and each of Build my program's states (pending, a generator failure, the
 * three conflicts, offline). Start week 1 is column chrome. Serial: each test sets up the one
 * owner's training profile or program (e2e/program-support.ts), and the last leaves it blank.
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
import { localDay } from '../src/lib/domain/dates';
import type { ProgramFixture } from '../src/lib/server/test-support/program-fixtures';
import {
	BELOW_DESKTOP_WIDTH,
	DESKTOP,
	DESKTOP_WIDTHS,
	boxOf,
	expectInColumn,
	expectMainCentred,
	expectNoShift,
	expectNoSideScroll,
	tokenPx
} from './desktop';
import { PROGRAM_TZ, seedProgram, type ProgramStart } from './program-support';
import {
	captureScreen,
	gotoHydrated,
	profileAction,
	query,
	resetTrainingProfile,
	SAME_ORIGIN,
	trackConsoleErrors
} from './support';

test.use({ ...DESKTOP, timezoneId: PROGRAM_TZ });

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test.afterAll(async () => {
	await resetTrainingProfile();
});

const THEMES = ['dark', 'light'] as const;
type Theme = (typeof THEMES)[number];

const side = (page: Page) => page.getByTestId('today-side');
const heading = (page: Page) => page.getByRole('heading', { level: 1, name: 'Today' });
const strip = (page: Page) => page.getByTestId('week-strip');
const day = (page: Page) => page.getByTestId('today-day');
const cards = (page: Page) => day(page).getByTestId('session-card');
const plan = (page: Page) => page.getByTestId('today-plan');
const rail = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const railLink = (page: Page, name: string) => rail(page).getByRole('link', { name });
const panelError = (page: Page) => page.getByTestId('today-panel-error');
/** The plan's own room while its code loads or fails (the summary's sits in the side column). */
const planRoom = (page: Page) => page.locator('[data-layout="wide"] > [data-testid="today-panel"]');

const buildCard = (page: Page) => page.getByTestId('today-build');
/** The Build card's live button, not its served copy (inert until the card's code arrives). */
const buildCta = (page: Page) =>
	page.locator('[data-testid="today-build-cta"]:not([data-served] *)');
const preview = (page: Page) => page.getByTestId('build-preview');
const ready = (page: Page) => page.getByTestId('build-preview-ready');
const start = (page: Page) => page.getByTestId('build-start');
const notice = (page: Page) => page.getByTestId('build-notice');
const buildWeek = (page: Page) => page.getByTestId('build-week');
const buildPlan = (page: Page) => page.getByTestId('build-plan');

/**
 * axe (WCAG 2.1 A/AA) and a screenshot of the page as it stands, in each theme, switched in place
 * so a state that is hard to reach again (a failed load, offline, a conflict) is checked in both.
 */
async function auditBothThemes(
	page: Page,
	testInfo: Parameters<typeof captureScreen>[1],
	name: string
) {
	await page.waitForFunction(() => document.fonts.status === 'loaded');
	for (const theme of THEMES) {
		await page.evaluate((t: Theme) => {
			if (t === 'dark') delete document.documentElement.dataset.theme;
			else document.documentElement.dataset.theme = t;
		}, theme);
		await page.waitForTimeout(400); // colour transitions settle: contrast on final colours
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		expect(
			violations.flatMap((v) =>
				v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
			),
			`axe, ${name}, ${theme}`
		).toEqual([]);
		await captureScreen(
			page,
			testInfo,
			`today-desktop-${name}${theme === 'light' ? '-light' : ''}`
		);
	}
	await page.evaluate(() => delete document.documentElement.dataset.theme);
}

/** `main` lies wholly left of `beside`, and their tops are level (±1 px). */
async function expectBeside(main: Locator, beside: Locator) {
	const [left, right] = [await boxOf(main), await boxOf(beside)];
	expect(left.x + left.width, `${main} ends before ${beside} starts`).toBeLessThanOrEqual(right.x);
	expect(Math.abs(left.y - right.y), `${main} and ${beside} start level`).toBeLessThanOrEqual(1);
}

/** The screen is wide (centred beside the rail at --content-wide) and nothing scrolls sideways. */
async function expectWideFrame(page: Page) {
	await expectMainCentred(page, await tokenPx(page, '--content-wide'));
	await expectNoSideScroll(page);
}

/** Nothing scrolls sideways at any desktop width, nor just below them; back to 1440 after. */
async function expectNoSideScrollAtEveryWidth(page: Page) {
	for (const width of [...DESKTOP_WIDTHS, BELOW_DESKTOP_WIDTH]) {
		await page.setViewportSize({ width, height: 900 });
		await expectNoSideScroll(page);
	}
	await page.setViewportSize(DESKTOP.viewport);
}

/** The state's main action is in the window as the screen opens, without scrolling. */
async function expectInView(page: Page, target: Locator) {
	await expect(target).toBeVisible();
	const box = await boxOf(target);
	const { height } = page.viewportSize()!;
	expect(box.y, `${target} starts in the window`).toBeGreaterThanOrEqual(0);
	expect(box.y + box.height, `${target} ends in the window`).toBeLessThanOrEqual(height);
}

/** A hover tints `target` (a fine pointer), and the keyboard shows its focus ring. */
async function expectHoverAndFocus(page: Page, target: Locator, property: 'background' | 'border') {
	const read = () =>
		target.evaluate(
			(el, p) => getComputedStyle(el)[p === 'background' ? 'backgroundColor' : 'borderColor'],
			property
		);
	const resting = await read();
	await target.hover();
	await expect.poll(read, { message: `${target} has a hover state` }).not.toBe(resting);
	await page.mouse.move(5, 5);
	await target.focus();
	await page.keyboard.press('Shift+Tab');
	await page.keyboard.press('Tab');
	await expect(target).toBeFocused();
	expect(
		await target.evaluate((el) => getComputedStyle(el).outlineStyle),
		`${target} shows a focus ring`
	).not.toBe('none');
}

/** The least a finished training profile needs (one goal and a schedule), then Finish. */
const SCHEDULE = {
	daysPerWeek: 3,
	availableDays: [],
	preferredTimes: [],
	sessionMinutes: 60,
	commitments: []
};

async function completeProfile(request: APIRequestContext) {
	await profileAction(request, '/profile/goals?/saveGoal', {
		kind: 'general',
		title: 'Stay strong',
		disciplines: ['strength'],
		focus: 'Stay strong',
		measure: 'Train every planned week'
	});
	await profileAction(request, '/profile/schedule?/save', SCHEDULE);
	const finish = await request.post('/onboarding/review?/complete', {
		headers: { ...SAME_ORIGIN, accept: 'application/json', 'x-sveltekit-action': 'true' },
		multipart: { payload: '{}' }
	});
	expect(await finish.json()).toMatchObject({ type: 'redirect', location: '/today' });
}

/** A fixture program, with onboarding complete so Today shows it. */
async function seed(request: APIRequestContext, fixture: ProgramFixture, start: ProgramStart) {
	const seeded = await seedProgram(request, { fixture, start });
	await query('update athlete_profiles set onboarding_completed_at = now()');
	return seeded;
}

/** Today's Build card is tapped and the preview is shown. */
async function openPreview(page: Page) {
	await gotoHydrated(page, '/today');
	await buildCta(page).click();
	await expect(ready(page)).toBeVisible({ timeout: 15_000 });
}

/** A form action of Today's, by name: `?/preview` or `?/build`. */
const action = (name: string) => (url: URL) =>
	url.pathname === '/today' && url.search === `?/${name}`;

/** Serve the app's scripts, handing each request for the chunk carrying `markup` to `chunk`. */
async function routeChunk(
	page: Page,
	markup: string,
	chunk: (route: Route, response: APIResponse) => Promise<void>
) {
	await page.route('**/_app/immutable/**/*.js', async (route) => {
		const response = await route.fetch().catch(() => null);
		if (!response) return route.abort('internetdisconnected');
		const body = await response.text();
		if (!body.includes(markup)) return route.fulfill({ response, body });
		await chunk(route, response);
	});
}

/** Only the Program panel's chunk carries its empty Up next's test id. */
const PROGRAM_MARKUP = 'today-up-next-empty';
/** Only the BuildPreview panel's chunk carries its pending state's test id. */
const PREVIEW_MARKUP = 'build-preview-pending';

test('setup: the week across the top, the setup card beside This week', async ({
	page
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	await gotoHydrated(page, '/today');
	const card = page.getByTestId('today-setup');
	await expect(card).toBeVisible();
	await expectWideFrame(page);

	// The week spans the content, wider than any readable column.
	const week = await boxOf(page.getByRole('list', { name: 'This week' }));
	const sideBox = await boxOf(side(page));
	expect(week.width).toBeGreaterThan(await tokenPx(page, '--content-readable'));
	expect(Math.abs(week.x + week.width - (sideBox.x + sideBox.width))).toBeLessThanOrEqual(1);

	await expectBeside(card, side(page));
	await expect(side(page).getByRole('heading', { name: 'This week' })).toBeVisible();
	await expect(page.getByRole('link', { name: /Plate calculator/ })).toHaveCount(0);
	const cta = page.getByTestId('today-setup-continue');
	await expectInView(page, cta);
	await expectHoverAndFocus(page, cta, 'background');
	await expectNoSideScrollAtEveryWidth(page);
	await auditBothThemes(page, testInfo, 'setup');
	expect(errors).toEqual([]);
});

test('ready: the Build card beside the goals and the schedule', async ({
	page,
	request
}, testInfo) => {
	await completeProfile(request);
	await gotoHydrated(page, '/today');
	await expectBeside(buildCard(page), side(page));
	for (const part of ['today-goals', 'today-schedule']) {
		await expect(side(page).getByTestId(part)).toBeVisible();
	}
	// The goals lead the side column; This week follows, its disclosure with hover and focus.
	const [goalsBox, weekBox] = [
		await boxOf(side(page).getByTestId('today-goals')),
		await boxOf(side(page).getByTestId('today-week'))
	];
	expect(goalsBox.y + goalsBox.height).toBeLessThanOrEqual(weekBox.y);
	await expectHoverAndFocus(
		page,
		side(page).getByTestId('today-week').locator('summary'),
		'background'
	);
	await expectInView(page, buildCta(page));
	await expectHoverAndFocus(page, buildCta(page), 'background');
	await expectWideFrame(page);
	await auditBothThemes(page, testInfo, 'ready');
});

test.describe('a program with sessions today', () => {
	test.beforeEach(async ({ request }) => {
		await seed(request, 'today', 'this_week');
	});

	test('the strip spans the content; the day and Up next sit beside the side column', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await gotoHydrated(page, '/today');
		await expect(cards(page)).toHaveCount(2);
		await expectWideFrame(page);

		// The strip runs across both columns; the side column starts under it.
		const [week, sideBox, dayBox] = [
			await boxOf(strip(page)),
			await boxOf(side(page)),
			await boxOf(day(page))
		];
		expect(week.width).toBeGreaterThan(await tokenPx(page, '--content-readable'));
		expect(Math.abs(week.x - dayBox.x), 'the strip starts at the main column').toBeLessThan(1);
		expect(
			Math.abs(week.x + week.width - (sideBox.x + sideBox.width)),
			'the strip ends at the side column’s edge'
		).toBeLessThanOrEqual(1);
		expect(sideBox.y, 'the side column starts under the strip').toBeGreaterThan(
			week.y + week.height
		);
		await expectBeside(day(page), side(page));
		await expect(side(page).getByTestId('today-goals')).toBeVisible();
		const upNext = await boxOf(page.getByTestId('today-up-next'));
		expect(Math.abs(upNext.x - dayBox.x), 'Up next shares the day’s column').toBeLessThan(1);
		expect(upNext.y).toBeGreaterThan(dayBox.y + dayBox.height);

		await expectInView(page, cards(page).first());
		await expectHoverAndFocus(page, cards(page).first(), 'border');
		await expectNoSideScrollAtEveryWidth(page);
		// After this slice; Today's program state before it is today-session-desktop
		// (today-plan.serial.e2e.ts on the base branch).
		await auditBothThemes(page, testInfo, 'program');
		expect(errors).toEqual([]);
	});

	test.describe('with the network in the test’s hands', () => {
		// page.route never sees a request from a page the service worker controls on WebKit.
		test.use({ serviceWorkers: 'block' });

		test.afterEach(async ({ page }) => {
			await page.unrouteAll({ behavior: 'ignoreErrors' });
		});

		test('on a client navigation the plan replaces its skeleton in place: nothing moves', async ({
			page
		}) => {
			let release = () => {};
			const held = new Promise<void>((resolve) => (release = resolve));
			let requested = false;
			await routeChunk(page, PROGRAM_MARKUP, async (route, response) => {
				requested = true;
				await held;
				await route.fulfill({ response });
			});
			await gotoHydrated(page, '/train');
			await railLink(page, 'Today').click();
			await expect(page).toHaveURL(/\/today$/);
			await expect(planRoom(page)).toHaveAttribute('aria-busy', 'true');
			await expect.poll(() => requested, { message: 'the plan’s code is on its way' }).toBe(true);
			// The side column has settled (its summary is not held): only the plan is to come.
			await expect(side(page).getByTestId('today-goals')).toBeVisible();
			await page.waitForFunction(() => document.fonts.status === 'loaded');
			const reserved = await boxOf(planRoom(page));
			const sideBox = await boxOf(side(page));
			expect(reserved.x + reserved.width, 'the skeleton keeps to the main column').toBeLessThan(
				sideBox.x
			);

			await expectNoShift(page, {
				boxes: [heading(page), side(page)],
				action: async () => {
					release();
					await expect(cards(page)).toHaveCount(2);
				}
			});
			await expect(planRoom(page)).toHaveCount(0);
			const week = await boxOf(strip(page));
			expect(Math.abs(week.y - reserved.y), 'the strip starts where the skeleton did').toBeLessThan(
				1
			);
		});

		test('the plan’s code failing is a designed notice in the main column; Retry loads it', async ({
			page
		}, testInfo) => {
			let failing = true;
			await routeChunk(page, PROGRAM_MARKUP, async (route, response) => {
				if (failing) await route.abort('internetdisconnected');
				else await route.fulfill({ response });
			});
			await gotoHydrated(page, '/today');
			const failed = panelError(page);
			await expect(failed).toContainText('Couldn’t load this part of Today');
			const [box, sideBox, title] = [
				await boxOf(failed),
				await boxOf(side(page)),
				await boxOf(heading(page))
			];
			expect(box.x + box.width, 'the notice keeps to the main column').toBeLessThanOrEqual(
				sideBox.x
			);
			expect(Math.abs(box.x - title.x), 'the notice starts at the content’s edge').toBeLessThan(1);
			await expect(side(page).getByTestId('today-goals')).toBeVisible();
			const retry = failed.getByRole('button', { name: 'Retry' });
			await expectInView(page, retry);
			await expectHoverAndFocus(page, retry, 'background');
			await expectWideFrame(page);
			await auditBothThemes(page, testInfo, 'program-retry');

			// WebKit imports the chunk again in place; Chromium keeps the failed fetch and reloads.
			failing = false;
			await retry.click();
			await expect(cards(page)).toHaveCount(2);
			await expect(panelError(page)).toHaveCount(0);
			await expectBeside(day(page), side(page));
		});

		test('a failed read is the error view in the readable column; Try again loads Today', async ({
			page
		}, testInfo) => {
			await gotoHydrated(page, '/train');
			await page.route('**/today/__data.json*', (route) =>
				route.fulfill({
					status: 500,
					contentType: 'application/json',
					body: JSON.stringify({ message: 'Something went wrong on our side.', requestId: 'e2e' })
				})
			);
			await railLink(page, 'Today').click();
			const error = page.getByTestId('error-view');
			await expect(error).toContainText('Something went wrong');
			await expect(rail(page)).toBeVisible();
			// An error is not a dashboard: it keeps the readable column (Responsive layout → Screens).
			await expectMainCentred(page, await tokenPx(page, '--content-readable'));
			await expectNoSideScroll(page);
			const tryAgain = error.getByRole('button', { name: 'Try again' });
			await expectInView(page, tryAgain);
			await auditBothThemes(page, testInfo, 'error');

			await page.unrouteAll({ behavior: 'ignoreErrors' });
			await tryAgain.click();
			await expect(cards(page)).toHaveCount(2);
			await expectWideFrame(page);
		});

		test('offline, Today is the designed offline state, and the rail still navigates', async ({
			page,
			context
		}, testInfo) => {
			await gotoHydrated(page, '/train');
			await context.setOffline(true);
			await railLink(page, 'Today').click();
			await expect(page.getByTestId('offline-state')).toBeVisible();
			await expect(page.locator('body')).not.toContainText(/internal error/i);
			await expect(rail(page).getByRole('link')).toHaveCount(5);
			await expectMainCentred(page, await tokenPx(page, '--content-readable'));
			await expectNoSideScroll(page);
			await auditBothThemes(page, testInfo, 'offline');

			await context.setOffline(false);
			await railLink(page, 'Train').click();
			await expect(page).toHaveURL(/\/train$/);
			await expect(page.getByTestId('program-header')).toBeVisible();
			await railLink(page, 'Today').click();
			await expect(cards(page)).toHaveCount(2);
			await expectWideFrame(page);
		});

		test('back online, the offline screen loads Today again by itself, with its styles', async ({
			page,
			context
		}) => {
			// Today's code and stylesheets are first asked for offline, so they fail to load.
			await gotoHydrated(page, '/train');
			await context.setOffline(true);
			await railLink(page, 'Today').click();
			await expect(page.getByTestId('offline-state')).toBeVisible();

			// No tap: the screen's own recovery brings Today back, styled. Vite never links a
			// stylesheet URL the page already has a (failed) link for, so only the recovery's
			// reload of those links can style it.
			await context.setOffline(false);
			await expect(cards(page)).toHaveCount(2, { timeout: 20_000 });
			await expect(page.locator('[data-layout="wide"]')).toHaveCSS('display', 'grid');
			await expectBeside(day(page), side(page));
			await expectWideFrame(page);
		});
	});
});

test('a rest day is designed in the main column, beside the side column', async ({
	page,
	request
}, testInfo) => {
	await seed(request, 'today-rest', 'this_week');
	await gotoHydrated(page, '/today');
	const rest = page.getByTestId('today-rest');
	await expect(rest).toContainText('Rest day');
	await expectBeside(day(page), side(page));
	await expectInView(page, rest);
	await expectWideFrame(page);
	await auditBothThemes(page, testInfo, 'rest-day');
});

test('a program that starts next Monday says so under the strip, beside the side column', async ({
	page,
	request
}, testInfo) => {
	await seed(request, 'hybrid', 'next_week');
	await gotoHydrated(page, '/today');
	const starts = page.getByTestId('today-starts');
	await expect(starts.getByRole('heading', { level: 2 })).toHaveText('Starts Monday');
	const week = await boxOf(strip(page));
	expect((await boxOf(starts)).y, 'the note sits under the strip').toBeGreaterThan(
		week.y + week.height
	);
	await expectBeside(starts, side(page));
	await expectInView(page, starts);
	await expectWideFrame(page);
	await auditBothThemes(page, testInfo, 'starts');
});

test('the first block complete: its summary level with the side column', async ({
	page,
	request
}, testInfo) => {
	await seed(request, 'one-week', 'last_week');
	await gotoHydrated(page, '/today');
	const complete = page.getByTestId('today-block-complete');
	await expect(complete.getByRole('heading')).toHaveText('Nothing planned yet');
	await expect(strip(page)).toHaveCount(0);
	// The plan's first block (the Surface around the summary) starts level with the side column.
	await expectBeside(plan(page).locator(':scope > *').first(), side(page));
	await expectInView(page, page.getByTestId('today-train-link'));
	await expectWideFrame(page);
	await auditBothThemes(page, testInfo, 'block-complete');
});

test.describe('Build my program', () => {
	test.beforeEach(async ({ request }) => {
		await completeProfile(request);
	});

	test('the block timeline sits beside week 1; Start week 1 is the main column’s chrome', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await openPreview(page);
		await expectWideFrame(page);
		await expectBeside(buildWeek(page), buildPlan(page));
		await expect(buildPlan(page).getByTestId('build-timeline')).toBeVisible();

		// Start sits at the foot of the main column, over neither the timeline nor the window's edge.
		await expectInColumn(page, start(page), buildWeek(page), [buildPlan(page)]);
		await expectInView(page, start(page));
		await expectHoverAndFocus(page, start(page), 'background');

		// It stays in the window while the preview scrolls…
		await page.mouse.move(DESKTOP.viewport.width / 2, DESKTOP.viewport.height / 2);
		await page.mouse.wheel(0, 600);
		await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
		await expectInColumn(page, start(page), buildWeek(page), [buildPlan(page)]);
		await expectInView(page, start(page));
		// …and comes to rest under the preview at its end.
		await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
		await expect
			.poll(() =>
				page.evaluate(
					() => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1
				)
			)
			.toBe(true);
		const last = await boxOf(ready(page).locator(':scope > *').last());
		expect((await boxOf(start(page))).y, 'Start comes after the preview').toBeGreaterThanOrEqual(
			last.y + last.height - 1
		);
		await page.evaluate(() => window.scrollTo(0, 0));

		await expectNoSideScrollAtEveryWidth(page);
		await auditBothThemes(page, testInfo, 'preview');
		expect(errors).toEqual([]);
	});

	test('a profile edit before Start: ‘Your profile changed’ over the preview, in its column', async ({
		page,
		request
	}, testInfo) => {
		await openPreview(page);
		await profileAction(request, '/profile/schedule?/save', { ...SCHEDULE, sessionMinutes: 45 });
		await start(page).click();
		await expect(notice(page)).toContainText('Your profile changed');
		await expect(ready(page)).toBeVisible({ timeout: 15_000 });
		await expectInColumn(page, notice(page), buildWeek(page), [buildPlan(page)]);
		await expectBeside(buildWeek(page), buildPlan(page));
		await expectWideFrame(page);
		await auditBothThemes(page, testInfo, 'preview-profile');
	});

	test('the library changed after the preview: ‘The exercise library was updated’', async ({
		page
	}, testInfo) => {
		await openPreview(page);
		// An own exercise changes the library's digest, as the 'library' conflict's tests do.
		await query(
			`insert into exercises (owner_id, name, pattern, primary_muscles, skill_level, measure, load_type)
			select id, 'Sled push', 'carry', '{quads}', 'beginner', 'reps', 'external' from owners`
		);
		await start(page).click();
		await expect(notice(page)).toContainText('The exercise library was updated');
		await expect(ready(page)).toBeVisible({ timeout: 15_000 });
		await expectInColumn(page, notice(page), buildWeek(page), [buildPlan(page)]);
		await expectWideFrame(page);
		await auditBothThemes(page, testInfo, 'preview-library');
	});

	test.describe('across the date line', () => {
		// 25 hours apart: Kiritimati's date is always a day or two after Pago Pago's.
		const PREVIEWED_IN = 'Pacific/Pago_Pago';
		const STARTED_IN = 'Pacific/Kiritimati';
		test.use({ timezoneId: PREVIEWED_IN });

		test('a build sent on a later date than its preview: ‘It’s a new day’', async ({
			page
		}, testInfo) => {
			await openPreview(page);
			await page
				.getByTestId('build-start-choice')
				.getByRole('radio', { name: /This week/ })
				.check();
			await expect(preview(page)).toHaveAttribute(
				'data-first-planned-day',
				localDay(new Date(), PREVIEWED_IN)
			);
			await expect(ready(page)).toBeVisible({ timeout: 15_000 });
			// The device's zone changes before Start: the build counts today from Kiritimati.
			await page.evaluate((zone) => {
				const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
				Intl.DateTimeFormat.prototype.resolvedOptions = function () {
					return { ...resolved.call(this), timeZone: zone };
				};
			}, STARTED_IN);
			await start(page).click();
			await expect(notice(page)).toContainText('It’s a new day');
			await expect(ready(page)).toBeVisible({ timeout: 15_000 });
			await expectInColumn(page, notice(page), buildWeek(page), [buildPlan(page)]);
			await expectWideFrame(page);
			await auditBothThemes(page, testInfo, 'preview-new-day');
		});
	});

	test.describe('with the network in the test’s hands', () => {
		// page.route never sees a request from a page the service worker controls on WebKit.
		test.use({ serviceWorkers: 'block' });

		test.afterEach(async ({ page }) => {
			await page.unrouteAll({ behavior: 'ignoreErrors' });
		});

		test('while week 1 is planned, the skeleton holds both columns; nothing moves as it arrives', async ({
			page
		}, testInfo) => {
			let release = () => {};
			const held = new Promise<void>((resolve) => (release = resolve));
			await page.route(action('preview'), async (route) => {
				await held;
				await route.continue();
			});
			await gotoHydrated(page, '/today');
			await buildCta(page).click();
			const pending = page.getByTestId('build-preview-pending');
			await expect(pending).toHaveAttribute('aria-busy', 'true');
			// The timeline's room (the second block) sits beside the rest, as the timeline will.
			const [lead, timeline] = [
				await boxOf(pending.locator(':scope > :nth-child(2)')),
				await boxOf(pending.locator(':scope > :nth-child(3)'))
			];
			expect(timeline.x, 'the timeline’s room is in the side column').toBeGreaterThan(
				lead.x + (await tokenPx(page, '--content-list'))
			);
			await expectWideFrame(page);
			await auditBothThemes(page, testInfo, 'preview-pending');

			await expectNoShift(page, {
				boxes: [heading(page), page.getByRole('heading', { level: 2, name: 'Build my program' })],
				action: async () => {
					release();
					await expect(ready(page)).toBeVisible({ timeout: 15_000 });
				}
			});
			await expectBeside(buildWeek(page), buildPlan(page));
			const landed = await boxOf(buildPlan(page));
			expect(Math.abs(landed.x - timeline.x), 'the timeline lands in its room').toBeLessThan(1);
		});

		test('a generator failure is a designed error with Retry, which recovers', async ({
			page
		}, testInfo) => {
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
			await buildCta(page).click();
			const failed = page.getByTestId('build-preview-error');
			await expect(failed).toContainText('Couldn’t plan week 1');
			const retry = failed.getByRole('button', { name: 'Retry' });
			await expectInView(page, retry);
			await expect(rail(page)).toBeVisible();
			await expectWideFrame(page);
			await auditBothThemes(page, testInfo, 'preview-failed');
			failing = false;
			await retry.click();
			await expect(ready(page)).toBeVisible({ timeout: 15_000 });
			await expectBeside(buildWeek(page), buildPlan(page));
		});

		test('offline, planning week 1 is a designed state with Retry', async ({
			page,
			context
		}, testInfo) => {
			await openPreview(page);
			await page.getByTestId('build-close').click();
			await expect(buildCard(page)).toBeVisible();
			await context.setOffline(true);
			await buildCta(page).click();
			const offline = page.getByTestId('build-preview-error');
			await expect(offline).toContainText('You’re offline');
			const retry = offline.getByRole('button', { name: 'Retry' });
			await expectInView(page, retry);
			await expectWideFrame(page);
			await auditBothThemes(page, testInfo, 'preview-offline');
			await context.setOffline(false);
			await retry.click();
			await expect(ready(page)).toBeVisible({ timeout: 15_000 });
		});

		test('the preview’s code failing: the notice in its main column; Retry opens it', async ({
			page
		}, testInfo) => {
			let failing = true;
			await routeChunk(page, PREVIEW_MARKUP, async (route, response) => {
				if (failing) await route.abort('internetdisconnected');
				else await route.fulfill({ response });
			});
			await gotoHydrated(page, '/today');
			await buildCta(page).click();
			const failed = panelError(page);
			await expect(failed).toContainText('Couldn’t load this part of Today');
			const [box, title] = [await boxOf(failed), await boxOf(heading(page))];
			const readable = await tokenPx(page, '--content-readable');
			expect(box.width, 'the notice keeps to the main column').toBeLessThanOrEqual(readable + 1);
			expect(Math.abs(box.x - title.x), 'the notice starts at the content’s edge').toBeLessThan(1);
			await expectInView(page, failed.getByRole('button', { name: 'Retry' }));
			await expectWideFrame(page);
			await auditBothThemes(page, testInfo, 'preview-retry');

			// WebKit imports the chunk again in place; Chromium reloads Today, where the Build card
			// opens the preview again.
			failing = false;
			await failed.getByRole('button', { name: 'Retry' }).click();
			const shown = ready(page).or(buildCard(page)).filter({ visible: true });
			await expect(shown).toBeVisible({ timeout: 15_000 });
			if (await buildCard(page).isVisible()) await buildCta(page).click();
			await expect(ready(page)).toBeVisible({ timeout: 15_000 });
			await expectBeside(buildWeek(page), buildPlan(page));
		});
	});
});
