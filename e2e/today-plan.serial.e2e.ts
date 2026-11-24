/**
 * Today once a program exists (src/routes/(app)/today/panels/Program.svelte, plan.server.ts),
 * Instrument v2 (v2/06b): the date, the week as seven dots, and at the foot the day: its title,
 * when, one sentence from the coach and one Start, then one line under it (a goal to set, or the
 * next session). A tap on a dot shows that day, with Back to today. The designed rest-day,
 * starts-Monday, block-complete, skipped, failed and offline states, each a day of its own.
 * Serial: programs are the one owner's, which every browser and worker shares. Fixture programs
 * come from the test-only route at dates the server computes (e2e/program-support.ts), so these
 * hold on any weekday, Sunday included.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import { longDate } from '../src/lib/ui/program/words';
import { lineLabel, startsTitle, STARTS_LEAD } from '../src/routes/(app)/today/day-words';
import { DESKTOP, expectMainCentred, expectNoSideScroll, tokenPx } from './desktop';
import { PROGRAM_TZ, seedProgram, type ProgramStart, type SeededProgram } from './program-support';
import type { ProgramFixture } from '../src/lib/server/test-support/program-fixtures';
import {
	captureScreen,
	gotoHydrated,
	profileAction,
	query,
	resetTrainingProfile,
	toastWith,
	trackConsoleErrors
} from './support';

test.use({ timezoneId: PROGRAM_TZ });

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test.afterAll(async () => {
	await resetTrainingProfile();
});

/** A program stored by the fixture route, with onboarding complete so Today shows it. */
async function seed(
	request: APIRequestContext,
	fixture: ProgramFixture,
	start: ProgramStart
): Promise<SeededProgram> {
	const seeded = await seedProgram(request, { fixture, start });
	await query('update athlete_profiles set onboarding_completed_at = now()');
	return seeded;
}

/** The sessions after the server's today, in date order (plan order within a day). */
const after = (seeded: SeededProgram) =>
	seeded.sessions.filter((s) => s.date > seeded.today).sort((a, b) => a.date.localeCompare(b.date));

/** Count layout shifts that no input explains (CLS), where the browser reports them. */
async function watchShifts(page: Page) {
	await page.addInitScript(() => {
		const shifts: number[] = [];
		Object.assign(window, { __shifts: shifts });
		if (!PerformanceObserver.supportedEntryTypes.includes('layout-shift')) return;
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries() as (PerformanceEntry & {
				value: number;
				hadRecentInput: boolean;
			})[]) {
				if (!entry.hadRecentInput) shifts.push(entry.value);
			}
		}).observe({ type: 'layout-shift', buffered: true });
	});
}
const shifts = (page: Page) =>
	page.evaluate(() => (window as unknown as { __shifts: number[] }).__shifts);

async function audit(page: Page): Promise<string[]> {
	await page.waitForFunction(() => document.fonts.status === 'loaded');
	await page.waitForTimeout(400); // entrance transitions settle: contrast on final colours
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) =>
		v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
	);
}

/** Axe in the dark and light themes, Today reloaded in each. */
async function auditThemes(page: Page) {
	for (const theme of ['dark', 'light'] as const) {
		await page.evaluate(
			(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
			theme
		);
		await gotoHydrated(page, '/today');
		const html = page.locator('html');
		if (theme === 'light') await expect(html).toHaveAttribute('data-theme', 'light');
		else await expect(html).not.toHaveAttribute('data-theme', /.*/);
		expect(await audit(page), `axe, ${theme}`).toEqual([]);
	}
}

const dots = (page: Page) => page.getByTestId('week-dots');
const dot = (page: Page, date: string) => dots(page).locator(`[data-date="${date}"]`);
const day = (page: Page) => page.getByTestId('today-day');
const title = (page: Page) => page.getByTestId('today-title');
const start = (page: Page) => day(page).getByTestId('start-workout');
const lineOf = (page: Page, kind: string) =>
	page.locator(`[data-testid="today-line"][data-kind="${kind}"]`);
const logLink = (page: Page) => page.getByTestId('log-something-else');
const todayTab = (page: Page) =>
	page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Today' });

/** Skip a session from its own page, as the owner does. */
async function skipFromItsPage(page: Page, lineage: string, toast: string) {
	await gotoHydrated(page, `/train/session/${lineage}`);
	await page.getByTestId('skip-session').click();
	const sheet = page.getByRole('dialog', { name: 'Skip session' });
	await expect(sheet.getByLabel(/^Reason/)).toBeVisible();
	await sheet.getByTestId('edit-save').click();
	await expect(toastWith(page, toast)).toBeVisible();
}

test.describe('a program with sessions today', () => {
	let seeded: SeededProgram;
	test.beforeEach(async ({ request }) => {
		seeded = await seed(request, 'today', 'this_week');
	});
	const todays = (title: string) =>
		seeded.sessions.find((s) => s.date === seeded.today && s.title === title)!;

	test('Today is the day: one Start, the one line, and the week as dots a tap away from any day', async ({
		page,
		request
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await watchShifts(page);
		// The phone's window (the iPhone 15 Pro's): Start has to clear the tab bar in it.
		await page.setViewportSize({ width: 393, height: 659 });
		await gotoHydrated(page, '/today');

		// The date on the top line, then the week: seven days, today current and pressed.
		await expect(page.getByTestId('today-date')).toHaveText(/^\w+day \d{1,2} \w+$/);
		expect((await page.getByTestId('today-date').boundingBox())!.y).toBeLessThan(
			(await dots(page).boundingBox())!.y
		);
		await expect(dots(page).getByRole('button')).toHaveCount(7);
		const today = dot(page, seeded.today);
		await expect(today).toHaveAttribute('aria-current', 'date');
		await expect(today).toHaveAttribute('aria-pressed', 'true');
		await expect(today).toHaveAccessibleName(new RegExp(`^${longDate(seeded.today)}, today`));
		await expect(page.getByRole('list', { name: 'This week' })).toHaveCount(0);

		// The day: the first session to do, when, one sentence, one Start.
		await expect(day(page)).toHaveAttribute('data-state', 'session');
		await expect(title(page)).toHaveText('Full body');
		await expect(page.getByTestId('today-when')).toBeVisible();
		await expect(page.getByTestId('today-coach')).toBeVisible();
		await expect(page.getByTestId('start-workout')).toHaveCount(1);
		await expect(start(page)).toHaveText('Start');
		await expect(start(page)).toHaveAttribute(
			'href',
			`/workout?start=${todays('Full body').lineage}`
		);
		const startBox = (await start(page).boundingBox())!;
		expect(startBox.height).toBeGreaterThanOrEqual(44);
		const tabBar = (await page.getByRole('navigation', { name: 'Primary' }).boundingBox())!;
		expect(startBox.y + startBox.height, 'Start ends at or above the tab bar').toBeLessThanOrEqual(
			tabBar.y
		);
		// No goal set yet: the one line asks for one. Up next and Ask the coach are gone.
		const goal = lineOf(page, 'goal');
		await expect(goal).toContainText('None set yet');
		await expect(goal).toContainText('Add one');
		await expect(goal).toHaveAttribute('href', '/profile/goals');
		for (const gone of ['week-strip', 'up-next-card', 'today-up-next', 'ask-coach']) {
			await expect(page.getByTestId(gone)).toHaveCount(0);
		}
		await expect(logLink(page)).toHaveCount(0);
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'today-session');
		expect(await shifts(page), 'layout shifts no input explains').toEqual([]);

		// Another day, tapped: its session (or its rest) with no Start, and the way back to today.
		const earlier = seeded.sessions.find((s) => s.date < seeded.today);
		const other = earlier?.date ?? addDays(seeded.today, 1);
		await dot(page, other).click();
		await expect(dot(page, other)).toHaveAttribute('aria-pressed', 'true');
		await expect(today).toHaveAttribute('aria-pressed', 'false');
		await expect(day(page)).toHaveAttribute('data-state', 'other-day');
		await expect(page.getByTestId('start-workout')).toHaveCount(0);
		if (earlier) {
			await expect(title(page)).toHaveText(earlier.title);
			await expect(page.getByTestId('open-session')).toHaveAttribute(
				'href',
				`/train/session/${earlier.lineage}`
			);
		} else {
			await expect(title(page)).toHaveText('Rest day');
		}
		await captureScreen(page, testInfo, 'today-other-day');
		await page.getByTestId('today-back').click();
		await expect(title(page)).toHaveText('Full body');
		await expect(today).toBeFocused();
		expect(errors).toEqual([]);

		await auditThemes(page);

		// With a goal set, the one line is the next session: the class later today, which opens it.
		await profileAction(request, '/profile/goals?/saveGoal', {
			kind: 'general',
			title: 'Stay strong',
			disciplines: ['strength'],
			focus: 'Stay strong',
			measure: 'Train every planned week'
		});
		await gotoHydrated(page, '/today');
		const later = lineOf(page, 'later');
		await expect(later).toContainText('Later');
		await expect(later).toContainText('Muay Thai class');
		await later.click();
		await expect(page).toHaveURL(`/train/session/${todays('Muay Thai class').lineage}`);
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Muay Thai class');
	});

	test('skipping today’s sessions from their page: the next one leads, then the day reads Skipped', async ({
		page
	}) => {
		await skipFromItsPage(page, todays('Full body').lineage, 'Skipped Full body · version 2');
		await todayTab(page).click();
		await expect(page).toHaveURL('/today');
		await expect(title(page)).toHaveText('Muay Thai class');
		await expect(dot(page, seeded.today)).toHaveAccessibleName(/1 skipped/);
		await expect(dot(page, seeded.today)).toHaveAttribute('data-mark', 'today');

		await skipFromItsPage(page, todays('Muay Thai class').lineage, 'Skipped Muay Thai class');
		await todayTab(page).click();
		await expect(page).toHaveURL('/today');
		await expect(day(page)).toHaveAttribute('data-state', 'skipped');
		await expect(title(page)).toHaveText('Skipped');
		await expect(page.getByTestId('today-when')).toHaveText(
			'Full body and Muay Thai class. The rest of the week stays as it is.'
		);
		await expect(page.getByTestId('start-workout')).toHaveCount(0);
		await expect(logLink(page)).toHaveText('Log something anyway');
		await expect(logLink(page)).toHaveAttribute('href', '/workout');
		await expect(dot(page, seeded.today)).toHaveAttribute('data-mark', 'skipped');
		await expect(dot(page, seeded.today)).toHaveAccessibleName(/2 skipped/);
	});

	test.describe('with the network in the test’s hands', () => {
		// page.route never sees a request from a page the service worker controls on WebKit.
		test.use({ serviceWorkers: 'block' });

		// A failed client navigation is the (app) layout's error view, inside the shell; the plan's
		// own designed statement, for a server read that fails, is the streamed fail-soft payload
		// (tests/integration/training/today-load.test.ts).
		test('a client navigation whose data fails shows the designed error, whose Try again recovers', async ({
			page
		}) => {
			await gotoHydrated(page, '/train');
			await page.route('**/today/__data.json*', (route) =>
				route.fulfill({
					status: 500,
					contentType: 'application/json',
					body: JSON.stringify({ message: 'Something went wrong on our side.', requestId: 'e2e' })
				})
			);
			await todayTab(page).click();
			const error = page.getByTestId('error-view');
			await expect(error).toBeVisible();
			await expect(error).toContainText('Something went wrong');
			await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

			await page.unrouteAll({ behavior: 'ignoreErrors' });
			await error.getByRole('button', { name: 'Try again' }).click();
			await expect(title(page)).toHaveText('Full body');
			await expect(page.getByTestId('today-loading')).toHaveCount(0);
		});

		test('offline, going to Today shows the designed offline state, never a 500', async ({
			page,
			context
		}) => {
			await gotoHydrated(page, '/train');
			await context.setOffline(true);
			await todayTab(page).click();
			await expect(page.getByTestId('offline-state')).toBeVisible();
			await expect(page.locator('body')).not.toContainText(/internal error/i);
			await context.setOffline(false);
		});
	});

	test.describe('in a desktop window', () => {
		test.use(DESKTOP);

		test('the day sits in the readable column with a 260 px Start, which has hover and focus states', async ({
			page
		}, testInfo) => {
			await gotoHydrated(page, '/today');
			await expect(title(page)).toHaveText('Full body');
			await expectMainCentred(page, await tokenPx(page, '--content-readable'));
			await expectNoSideScroll(page);
			const main = (await page.locator('main#main').boundingBox())!;
			const box = (await day(page).boundingBox())!;
			expect(box.x).toBeGreaterThanOrEqual(main.x - 1);
			expect(box.x + box.width).toBeLessThanOrEqual(main.x + main.width + 1);
			expect(box.width, 'the day keeps to the 560 px column').toBeLessThanOrEqual(561);
			await expect(page.getByTestId('today-side')).toHaveCount(0);
			const go = start(page);
			expect(Math.abs((await go.boundingBox())!.width - 260)).toBeLessThanOrEqual(1);
			const fill = () => go.evaluate((el) => getComputedStyle(el).backgroundColor);
			const resting = await fill();
			await go.hover();
			await expect.poll(fill).not.toBe(resting);
			await page.mouse.move(0, 0);
			await go.focus();
			await expect(go).toBeFocused();
			await captureScreen(page, testInfo, 'today-session-desktop');
		});
	});
});

test('a rest day says so, names the next session and offers to log something anyway', async ({
	page,
	request
}, testInfo) => {
	const seeded = await seed(request, 'today-rest', 'this_week');
	await gotoHydrated(page, '/today');
	await expect(day(page)).toHaveAttribute('data-state', 'rest');
	await expect(title(page)).toHaveText('Rest day');
	await expect(page.getByTestId('start-workout')).toHaveCount(0);
	const next = after(seeded)[0]!;
	await expect(lineOf(page, 'later')).toContainText(next.title);
	await expect(lineOf(page, 'later')).toContainText(lineLabel(next.date, seeded.today));
	await expect(logLink(page)).toHaveText('Log something anyway');
	await expect(logLink(page)).toHaveAttribute('href', '/workout');
	await captureScreen(page, testInfo, 'today-rest');
	await auditThemes(page);
});

test('a program that starts next week names the day, with week 1’s first session', async ({
	page,
	request
}, testInfo) => {
	const seeded = await seed(request, 'hybrid', 'next_week');
	const first = [...seeded.sessions].sort((a, b) => a.date.localeCompare(b.date))[0]!;
	await gotoHydrated(page, '/today');
	await expect(day(page)).toHaveAttribute('data-state', 'starts');
	await expect(title(page)).toHaveText(startsTitle(seeded.weekStart, seeded.today));
	await expect(page.getByTestId('today-when')).toHaveText(STARTS_LEAD);
	const line = page.getByTestId('today-line');
	await expect(line).toContainText(first.title);
	await expect(line).toContainText(lineLabel(first.date, seeded.today));
	await expect(logLink(page)).toHaveText('Log something anyway');
	// No week to show before week 1.
	await expect(dots(page)).toHaveCount(0);
	await captureScreen(page, testInfo, 'today-starts');
	await auditThemes(page);
});

test('a finished first block shows ‘Nothing yet’, the way back to every week, and Log something', async ({
	page,
	request
}, testInfo) => {
	await seed(request, 'one-week', 'last_week');
	await gotoHydrated(page, '/today');
	await expect(day(page)).toHaveAttribute('data-state', 'complete');
	await expect(title(page)).toHaveText('Nothing yet');
	await expect(page.getByTestId('today-when')).toContainText(
		'I plan the next block from how this one went.'
	);
	await expect(dots(page)).toHaveCount(0);
	await expect(logLink(page)).toContainText('Log something');
	await expect(logLink(page)).toHaveAttribute('href', '/workout');
	await captureScreen(page, testInfo, 'today-block-complete');
	await auditThemes(page);

	const back = page.getByTestId('today-train-link');
	await expect(back).toContainText('Look back at every week');
	await back.click();
	await expect(page).toHaveURL('/train');
	await expect(page.getByTestId('train-block-complete')).toBeVisible();
});
