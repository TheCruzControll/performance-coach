/**
 * Every way into a workout (start-entry-points): M3's 'workout-day' program, seeded this week,
 * has a strength session, an interval run and a Muay Thai class today.
 * - Today's day leads with the first session to do and its one Start, which opens
 *   /workout?start=<lineage>; back on Today the one in progress reads Resume. The session
 *   screen's Start workout and Resume do the same.
 * - Today saves the kits of today's sessions once idle, so Start works with no signal.
 * - A completed session is a done line on Today that opens its History detail; the session
 *   screen reads Done · View.
 * - A training day has no 'Log something' link (it is in Train's More); a rest day's 'Log
 *   something anyway' and Train's 'Log a session' open the ad-hoc options; History's empty state
 *   links to Today.
 * - The states are axe-clean in both themes and captured; on a desktop window Today's Start and
 *   the session's have hover and focus states and work by keyboard.
 * Serial: it stores a program, which empties the workouts. A test that fails requests with
 * page.route blocks the service worker (WebKit's page.route does not see a controlled page's
 * requests).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { DB_NAME, STORES } from '../src/lib/client/workout/names';
import type { StartKit, SyncResponse } from '../src/lib/domain/workout';
import { createMutation } from '../src/lib/domain/workout/mutations';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { openMore, PROGRAM_TZ, seedProgram, type SeededProgram } from './program-support';
import { captureScreen, gotoHydrated, query, resetTrainingProfile, SAME_ORIGIN } from './support';
import { historyAfterDone, readOutbox } from './workout-support';

test.use({ timezoneId: PROGRAM_TZ });

const STRENGTH = 'Lower body & pull';
const RUN = 'Intervals';

let seeded: SeededProgram;
// Onboarding complete, so Today shows the plan rather than the setup card.
test.beforeEach(async ({ request }) => {
	seeded = await seedProgram(request, { fixture: 'workout-day', start: 'this_week' });
	await query('update athlete_profiles set onboarding_completed_at = now()');
});
test.afterAll(async () => {
	await resetTrainingProfile();
});

const lineageOf = (title: string) =>
	seeded.sessions.find((s) => s.title === title && s.date === seeded.today)!.lineage;

/** Today's day: its title, when, one sentence and its one Start (or Resume). */
const todayDay = (page: Page) => page.getByTestId('today-day');
/** A session done today, as its line under the day: the link to its History detail. */
const doneLine = (page: Page, title: string) =>
	page.getByTestId('today-done').filter({ hasText: title }).getByTestId('done-workout');

const exerciseHeading = (page: Page) =>
	page.getByTestId('exercise').getByRole('heading', { level: 2 });

/** The workout in progress on this device: its planned session's lineage. */
const activeLineage = (page: Page) =>
	page.evaluate(
		async ({ name, store }) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(name);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			const all = db.transaction(store, 'readonly').objectStore(store).getAll();
			const rows = await new Promise<{ status: string; kit: StartKit | null }[]>(
				(resolve) => (all.onsuccess = () => resolve(all.result))
			);
			db.close();
			return rows.find((w) => w.status === 'in_progress')?.kit?.plannedLineage ?? null;
		},
		{ name: DB_NAME, store: STORES.workouts }
	);

/** A workout of the strength session, started and finished through the real sync endpoint. */
async function completeStrength(page: Page): Promise<string> {
	const answer = await page.request.get(`/api/workouts/kit?lineage=${lineageOf(STRENGTH)}`);
	expect(answer.status()).toBe(200);
	const kit = (await answer.json()) as StartKit;
	const workoutId = crypto.randomUUID();
	const at = Date.now() - 3_600_000;
	const { kind, title, sessionType, discipline, plannedSessionId, plannedLineage, programId } = kit;
	const mutations = [
		createMutation('workout.start', {
			workoutId,
			at: new Date(at).toISOString(),
			payload: { kind, title, sessionType, discipline, plannedSessionId, plannedLineage, programId }
		}),
		createMutation('workout.finish', {
			workoutId,
			at: new Date(at + 3_000_000).toISOString(),
			payload: {}
		})
	];
	const response = await page.request.post('/api/workouts/sync', {
		headers: SAME_ORIGIN,
		data: { v: 1, mutations }
	});
	expect(response.status()).toBe(200);
	const { results } = (await response.json()) as SyncResponse;
	expect(results.map((r) => r.status)).toEqual(['applied', 'applied']);
	return workoutId;
}

/** axe in both themes: the page as it is, then in the light theme. */
async function audit(page: Page, what: string) {
	for (const theme of ['dark', 'light']) {
		await page.evaluate((t) => {
			if (t === 'light') document.documentElement.dataset.theme = t;
			else delete document.documentElement.dataset.theme;
		}, theme);
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		const found = violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
		expect(found, `${what}, ${theme}`).toEqual([]);
	}
	await page.evaluate(() => delete document.documentElement.dataset.theme);
}

/** Today, once it has read the device and saved today's kits (on idle). */
async function openToday(page: Page) {
	await gotoHydrated(page, '/today');
	await expect(page.locator('[data-testid="today-plan"][data-kits="saved"]')).toBeAttached({
		timeout: 10_000
	});
}

test('Today starts the strength session, then reads Resume for it', async ({ page }, testInfo) => {
	await openToday(page);
	// One Start on the day: the first session to do. The later ones are on Train.
	await expect(page.getByTestId('today-title')).toHaveText(STRENGTH);
	const start = todayDay(page).getByTestId('start-workout');
	await expect(page.getByTestId('start-workout')).toHaveCount(1);
	await expect(start).toHaveText('Start');
	await expect(start).toHaveAttribute('href', `/workout?start=${lineageOf(STRENGTH)}`);
	// A training day offers no 'Log something': that is in Train's More.
	await expect(page.getByTestId('log-something-else')).toHaveCount(0);
	await captureScreen(page, testInfo, 'today-start');
	await audit(page, 'Today with Start workout');

	await start.click();
	await expect(page).toHaveURL(/\/workout$/);
	await expect(exerciseHeading(page)).toHaveText('Back squat');
	expect(await activeLineage(page)).toBe(lineageOf(STRENGTH));

	await openToday(page);
	const resume = todayDay(page).getByTestId('resume-workout');
	await expect(resume).toHaveText('Resume');
	await expect(resume).toHaveAttribute('href', '/workout');
	await expect(resume).toHaveAttribute('data-variant', 'primary');
	// The workout in progress is the day's one button.
	await expect(page.getByTestId('start-workout')).toHaveCount(0);
	await resume.click();
	await expect(page).toHaveURL(/\/workout$/);
	await expect(exerciseHeading(page)).toHaveText('Back squat');
});

test('the session screen’s Start starts it at its kind’s page, then reads Resume', async ({
	page
}, testInfo) => {
	const path = `/train/session/${lineageOf(RUN)}`;
	await gotoHydrated(page, path);
	const start = page.getByTestId('start-workout');
	await expect(start).toHaveText('Start workout');
	await captureScreen(page, testInfo, 'session-start');
	await audit(page, 'the session with Start workout');

	await start.click();
	await expect(page).toHaveURL(/\/workout\/run$/);
	await expect(page.getByTestId('run-main')).toBeVisible();
	expect(await activeLineage(page)).toBe(lineageOf(RUN));

	await gotoHydrated(page, path);
	const resume = page.getByTestId('resume-workout');
	await expect(resume).toHaveText('Resume');
	await expect(resume).toHaveAttribute('href', '/workout/run');
});

test('a completed session is a done line on Today that opens its History detail', async ({
	page
}) => {
	const workoutId = await completeStrength(page);
	const detail = `/progress/workouts/${workoutId}`;

	await openToday(page);
	// The next session leads the day; the done one is a quiet line under it.
	await expect(page.getByTestId('today-title')).toHaveText(RUN);
	const done = doneLine(page, STRENGTH);
	await expect(done).toContainText('Morning');
	await expect(done).toContainText(STRENGTH);
	await expect(done).toHaveAttribute('href', detail);
	await audit(page, 'Today with a session done');
	await done.click();
	await expect(page).toHaveURL(detail);
	await expect(page.getByTestId('workout-detail')).toBeVisible();

	await gotoHydrated(page, `/train/session/${lineageOf(STRENGTH)}`);
	await expect(page.getByTestId('done-workout')).toHaveAttribute('href', detail);
	await expect(page.getByTestId('start-workout')).toHaveCount(0);
});

test('a session finished here is done on Today reached in the app, before the bar looks again', async ({
	page
}) => {
	await openToday(page);
	await expect(page.getByTestId('resume-slot')).toBeAttached();
	await todayDay(page).getByTestId('start-workout').click();
	await expect(exerciseHeading(page)).toHaveText('Back squat');
	// The shell never loads its bar again in this document: Today reads only what it left behind.
	await page.evaluate(() => (window.requestIdleCallback = () => 0));

	await page.getByTestId('workout-menu-button').click();
	await page.getByTestId('workout-menu').getByTestId('menu-finish').click();
	await page.getByTestId('finish-sheet').getByTestId('finish-anyway').click();
	await page.getByTestId('finish-sheet').getByTestId('finish-done').click();
	await historyAfterDone(page);
	await expect(page.getByTestId('workout-detail')).toBeVisible();
	await page
		.getByRole('navigation', { name: 'Primary' })
		.getByRole('link', { name: 'Today' })
		.click();

	await expect(doneLine(page, STRENGTH)).toHaveAttribute('href', /^\/progress\/workouts\//);
	await expect(page.getByTestId('resume-workout')).toHaveCount(0);
	await expect(page.getByTestId('resume-slot')).toHaveCount(0);
});

test('a rest day’s Log something anyway and Train’s Log a session open the ad-hoc options', async ({
	page,
	request
}) => {
	await seedProgram(request, { fixture: 'today-rest', start: 'this_week' });
	await query('update athlete_profiles set onboarding_completed_at = now()');
	await gotoHydrated(page, '/today');
	await expect(page.getByTestId('today-day')).toHaveAttribute('data-state', 'rest');
	const log = page.getByTestId('log-something-else');
	await expect(log).toHaveText('Log something anyway');
	await log.click();
	await expect(page).toHaveURL(/\/workout$/);
	await expect(page.getByTestId('adhoc-run')).toBeVisible();
	await expect(page.getByTestId('adhoc-other')).toBeVisible();

	await gotoHydrated(page, '/train');
	await openMore(page);
	await page.getByTestId('log-a-session').click();
	await expect(page).toHaveURL(/\/workout$/);
	await expect(page.getByTestId('adhoc-run')).toBeVisible();
});

test('History’s empty state links to Today', async ({ page }) => {
	await gotoHydrated(page, '/progress/workouts');
	await expect(page.getByTestId('history-empty')).toBeVisible();
	await page.getByTestId('history-start').click();
	await expect(page).toHaveURL(/\/today$/);
});

test.describe('with no signal', () => {
	test.use({ serviceWorkers: 'block' });

	test('after Today loads online, Start still starts from the kit it saved', async ({ page }) => {
		await openToday(page);
		await page.route('**/api/workouts/**', (route) => route.abort('internetdisconnected'));
		await todayDay(page).getByTestId('start-workout').click();
		await expect(page).toHaveURL(/\/workout$/);
		await expect(exerciseHeading(page)).toHaveText('Back squat');
		await expect
			.poll(async () => (await readOutbox(page)).map((e) => e.envelope.type))
			.toEqual(['workout.start']);
	});
});

test.describe('in a desktop window', () => {
	test.use(DESKTOP);

	// A primary's hover changes its fill, a quiet link only its text, so the paint is the fill and
	// the text colour together.
	const paint = (locator: Locator) =>
		locator.evaluate((el) => {
			const style = getComputedStyle(el);
			return `${style.backgroundColor} ${style.color}`;
		});

	/** Hover changes it and leaving restores it; a keyboard focus draws the ring. */
	async function expectHoverAndFocus(page: Page, link: Locator) {
		await page.mouse.move(0, 0);
		const rest = await paint(link);
		await link.hover();
		await expect.poll(() => paint(link), 'on hover').not.toBe(rest);
		await page.mouse.move(0, 0);
		await expect.poll(() => paint(link)).toBe(rest);
		await link.focus();
		await expect(link).toBeFocused();
		await expect(link).toHaveCSS('outline-style', 'solid');
	}

	test('Today’s and the session’s Start have hover and focus states and work by keyboard', async ({
		page
	}, testInfo) => {
		await openToday(page);
		await expectNoSideScroll(page);
		const start = todayDay(page).getByTestId('start-workout');
		// Today's one Start is 260 px wide at a desk (Paper, 11 · Desktop).
		expect(Math.abs((await start.boundingBox())!.width - 260)).toBeLessThanOrEqual(1);
		await captureScreen(page, testInfo, 'desktop-today-start');
		await expectHoverAndFocus(page, start);
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\/workout$/);
		await expect(exerciseHeading(page)).toHaveText('Back squat');

		await gotoHydrated(page, `/train/session/${lineageOf(RUN)}`);
		await expectNoSideScroll(page);
		const sessionStart = page.getByTestId('start-workout');
		await expectHoverAndFocus(page, sessionStart);
		await page.keyboard.press('Enter');
		// The strength workout is in progress, so the run's start asks which to keep.
		await expect(page.getByTestId('start-conflict-sheet')).toBeVisible();
	});
});
