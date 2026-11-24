/**
 * Today in a desktop window (docs/design-system.md, Responsive layout → Screens): a readable
 * screen (v2/06b), the 560 px column 200 px from the rail with the right side empty. The date
 * heads it; with a program, the week as dots, then the day at the column's foot with its 260 px
 * Start, and the page does not scroll. The goals and schedule live in Profile and This week on
 * Progress (v2/06a), and the plate calculator lives in Train and the workout. Every designed state
 * keeps that frame: setup, ready, the program (a session day, a rest day, starting Monday, the
 * first block complete), a failed read, offline and a panel whose code fails. Build my program
 * still lays out across the wide main (until v2/06c), in each of its states (pending, a generator
 * failure, the three conflicts, offline), with Start week 1 as column chrome. Serial: each test
 * sets up the one owner's training profile or program (e2e/program-support.ts), and the last
 * leaves it blank.
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
import { startsTitle } from '../src/routes/(app)/today/day-words';
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

const heading = (page: Page) => page.getByRole('heading', { level: 1, name: 'Today' });
/** The date line: where the column's content starts (the h1 is for screen readers only). */
const dateLine = (page: Page) => page.getByTestId('today-date');
const dots = (page: Page) => page.getByTestId('week-dots');
/**
 * The live panel's day, not its served copy: after a reload (Chromium's Retry, or the offline
 * screen's recovery when it falls back to one) the server's markup shows first, the day and all,
 * and the live panel replaces that element once it mounts, so a box read from the copy is null.
 */
const day = (page: Page) => page.locator('[data-testid="today-day"]:not([data-served] *)');
const title = (page: Page) => day(page).getByTestId('today-title');
const startLink = (page: Page) => day(page).getByTestId('start-workout');
const rail = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const railLink = (page: Page, name: string) => rail(page).getByRole('link', { name });
const panelError = (page: Page) => page.getByTestId('today-panel-error');
/** The plan's own room while its code loads or fails. */
const planRoom = (page: Page) => page.locator('main#main [data-testid="today-panel"]');

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

/**
 * Build my program is wide (--content-wide, centred beside the rail but at most 200 px from it to
 * the text, as expectMainCentred places every screen) and nothing scrolls sideways.
 */
async function expectWideFrame(page: Page) {
	await expectMainCentred(page, await tokenPx(page, '--content-wide'));
	await expectNoSideScroll(page);
}

/** Today is readable (v2/06b): the 560 px column, and nothing scrolls sideways. */
async function expectReadableFrame(page: Page) {
	await expectMainCentred(page, await tokenPx(page, '--content-readable'));
	await expectNoSideScroll(page);
}

/**
 * `target` keeps to the one column (v2/06a: nothing beside it), at most the readable width and
 * starting at the content's edge, where the date starts (±1 px).
 */
async function expectInColumnAlone(page: Page, target: Locator) {
	const [box, edge] = [await boxOf(target), await boxOf(dateLine(page))];
	expect(Math.abs(box.x - edge.x), `${target} starts at the content’s edge`).toBeLessThan(1);
	expect(box.width, `${target} keeps to the readable column`).toBeLessThanOrEqual(
		(await tokenPx(page, '--content-readable')) + 1
	);
	await expect(page.getByTestId('today-side')).toHaveCount(0);
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

/** Only the Program panel's chunk carries the day's test id. */
const PROGRAM_MARKUP = '"today-day"';
/** Only the BuildPreview panel's chunk carries its pending state's test id. */
const PREVIEW_MARKUP = 'build-preview-pending';

test('setup: the date, then the setup card in the column under it', async ({ page }, testInfo) => {
	const errors = trackConsoleErrors(page);
	await gotoHydrated(page, '/today');
	const card = page.getByTestId('today-setup');
	await expect(card).toBeVisible();
	await expectReadableFrame(page);

	// No week before a program (v2/06b): the card sits under the date line, in its column.
	await expect(page.getByRole('list', { name: 'This week' })).toHaveCount(0);
	await expect(dots(page)).toHaveCount(0);
	const date = await boxOf(dateLine(page));
	expect((await boxOf(card)).y, 'the card sits under the date').toBeGreaterThan(
		date.y + date.height
	);
	await expectInColumnAlone(page, card);
	// As tall as what it says: no empty band between its words and its progress.
	const words = await boxOf(card.getByText('About five minutes'));
	const count = await boxOf(page.getByTestId('today-setup-count'));
	expect(
		count.y - (words.y + words.height),
		'the progress follows the words, with no dead space'
	).toBeLessThanOrEqual(await tokenPx(page, '--space-4'));
	await expect(page.getByRole('link', { name: /Plate calculator/ })).toHaveCount(0);
	const cta = page.getByTestId('today-setup-continue');
	await expectInView(page, cta);
	await expectHoverAndFocus(page, cta, 'background');
	await expectNoSideScrollAtEveryWidth(page);
	await auditBothThemes(page, testInfo, 'setup');
	expect(errors).toEqual([]);
});

test('ready: the Build card alone in its column', async ({ page, request }, testInfo) => {
	await completeProfile(request);
	await gotoHydrated(page, '/today');
	await expectInColumnAlone(page, buildCard(page));
	for (const gone of ['today-goals', 'today-schedule', 'today-week']) {
		await expect(page.getByTestId(gone)).toHaveCount(0);
	}
	await expectInView(page, buildCta(page));
	await expectHoverAndFocus(page, buildCta(page), 'background');
	await expectReadableFrame(page);
	await auditBothThemes(page, testInfo, 'ready');
});

test.describe('a program with sessions today', () => {
	test.beforeEach(async ({ request }) => {
		await seed(request, 'today', 'this_week');
	});

	test('the dots and the day share one column, its Start 260 px wide, and nothing scrolls', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await gotoHydrated(page, '/today');
		await expect(title(page)).toHaveText('Full body');
		await expectReadableFrame(page);

		// The dots head the column; the day stands at its foot, on the same left edge, 560 px wide.
		const [week, dayBox] = [await boxOf(dots(page)), await boxOf(day(page))];
		expect(Math.abs(week.x - dayBox.x), 'the dots start at the day’s column').toBeLessThanOrEqual(
			1
		);
		expect(dayBox.y, 'the day sits under the dots').toBeGreaterThan(week.y + week.height - 1);
		expect(Math.abs(dayBox.width - 560), `the day is ${dayBox.width}px wide`).toBeLessThanOrEqual(
			1
		);
		await expectInColumnAlone(page, dots(page));
		await expectInColumnAlone(page, day(page));
		for (const gone of ['week-strip', 'today-up-next', 'ask-coach', 'today-side']) {
			await expect(page.getByTestId(gone)).toHaveCount(0);
		}
		// The right side is left empty on purpose: nothing lies right of main.
		const main = await boxOf(page.locator('main#main'));
		for (const part of [dots(page), day(page), page.getByTestId('today-line')]) {
			const box = await boxOf(part);
			expect(box.x + box.width, `${part} keeps inside main`).toBeLessThanOrEqual(
				main.x + main.width + 1
			);
		}
		expect(
			await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1),
			'the page does not scroll at 1440 × 900'
		).toBe(true);

		const go = startLink(page);
		expect(Math.abs((await boxOf(go)).width - 260), 'Start is 260 px wide').toBeLessThanOrEqual(1);
		await expectInView(page, go);
		await expectHoverAndFocus(page, go, 'background');
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
			await expect(planRoom(page)).toContainText('Getting today');
			await expect.poll(() => requested, { message: 'the plan’s code is on its way' }).toBe(true);
			await page.waitForFunction(() => document.fonts.status === 'loaded');
			const reserved = await boxOf(planRoom(page));
			await expectInColumnAlone(page, planRoom(page));

			await expectNoShift(page, {
				boxes: [dateLine(page)],
				action: async () => {
					release();
					await expect(title(page)).toHaveText('Full body');
				}
			});
			await expect(planRoom(page)).toHaveCount(0);
			await expect(page.getByTestId('today-loading')).toHaveCount(0);
			// The day stands where the loading room ended: at the column's foot.
			const dayBox = await boxOf(day(page));
			expect(
				Math.abs(dayBox.y + dayBox.height - (reserved.y + reserved.height)),
				'the day ends where the room did'
			).toBeLessThanOrEqual(await tokenPx(page, '--space-20'));
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
			await expect(failed).toContainText('Couldn’t load today');
			await expectInColumnAlone(page, failed);
			const retry = failed.getByRole('button', { name: 'Try again' });
			await expectInView(page, retry);
			await expectHoverAndFocus(page, retry, 'background');
			await expectReadableFrame(page);
			await auditBothThemes(page, testInfo, 'program-retry');

			// WebKit imports the chunk again in place; Chromium keeps the failed fetch and reloads.
			failing = false;
			await retry.click();
			await expect(title(page)).toHaveText('Full body');
			await expect(panelError(page)).toHaveCount(0);
			await expectInColumnAlone(page, day(page));
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
			await expect(title(page)).toHaveText('Full body');
			await expectReadableFrame(page);
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
			await expect(title(page)).toHaveText('Full body');
			await expectReadableFrame(page);
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
			await expect(title(page)).toHaveText('Full body', { timeout: 20_000 });
			await expect(page.getByTestId('today-screen')).toHaveCSS('display', 'flex');
			await expectInColumnAlone(page, day(page));
			await expectReadableFrame(page);
		});
	});
});

test('a rest day is designed in the one column', async ({ page, request }, testInfo) => {
	await seed(request, 'today-rest', 'this_week');
	await gotoHydrated(page, '/today');
	await expect(day(page)).toHaveAttribute('data-state', 'rest');
	await expect(title(page)).toHaveText('Rest day');
	await expectInColumnAlone(page, day(page));
	await expectInView(page, page.getByTestId('log-something-else'));
	await expectReadableFrame(page);
	await auditBothThemes(page, testInfo, 'rest-day');
});

test('a program that starts next Monday names the day at the column’s foot, with no week', async ({
	page,
	request
}, testInfo) => {
	const seeded = await seed(request, 'hybrid', 'next_week');
	await gotoHydrated(page, '/today');
	await expect(day(page)).toHaveAttribute('data-state', 'starts');
	await expect(title(page)).toHaveText(startsTitle(seeded.weekStart, seeded.today));
	await expect(dots(page)).toHaveCount(0);
	await expectInColumnAlone(page, day(page));
	await expectInView(page, title(page));
	await expectReadableFrame(page);
	await auditBothThemes(page, testInfo, 'starts');
});

test('the first block complete: Nothing yet in the one column, with the way back to every week', async ({
	page,
	request
}, testInfo) => {
	await seed(request, 'one-week', 'last_week');
	await gotoHydrated(page, '/today');
	await expect(day(page)).toHaveAttribute('data-state', 'complete');
	await expect(title(page)).toHaveText('Nothing yet');
	await expect(dots(page)).toHaveCount(0);
	await expectInColumnAlone(page, day(page));
	expect((await boxOf(day(page))).y).toBeGreaterThan((await boxOf(dateLine(page))).y);
	await expectInView(page, page.getByTestId('today-train-link'));
	await expectReadableFrame(page);
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
			const retry = failed.getByRole('button', { name: 'Try again' });
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
			const retry = offline.getByRole('button', { name: 'Try again' });
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
			await expect(failed).toContainText('Couldn’t load today');
			const [box, edge] = [await boxOf(failed), await boxOf(dateLine(page))];
			const readable = await tokenPx(page, '--content-readable');
			expect(box.width, 'the notice keeps to the main column').toBeLessThanOrEqual(readable + 1);
			expect(Math.abs(box.x - edge.x), 'the notice starts at the content’s edge').toBeLessThan(1);
			await expectInView(page, failed.getByRole('button', { name: 'Try again' }));
			await expectWideFrame(page);
			await auditBothThemes(page, testInfo, 'preview-retry');

			// WebKit imports the chunk again in place; Chromium reloads Today, where the Build card
			// opens the preview again.
			failing = false;
			await failed.getByRole('button', { name: 'Try again' }).click();
			const shown = ready(page).or(buildCard(page)).filter({ visible: true });
			await expect(shown).toBeVisible({ timeout: 15_000 });
			if (await buildCard(page).isVisible()) await buildCta(page).click();
			await expect(ready(page)).toBeVisible({ timeout: 15_000 });
			await expectBeside(buildWeek(page), buildPlan(page));
		});
	});
});
