/**
 * The strength journeys (M4 brief journeys 1 and 5; PRD §18 and §19), end to end against the real
 * server, starting where the owner starts: Today.
 * 1. M3's 'workout-day' program, seeded this week: Today → Start workout → the back squat's top
 *    set and back-offs with weight, reps and RPE → the rest timer → the plate calculator from a
 *    set → the leg press swapped as machine unavailable (no preference, no new version) → the
 *    A1/A2 superset → a refresh that restores the exercise, every set, the rest (within 1 s) and
 *    the stopwatch exactly → the resume bar → Finish → History, its detail and Back squat's
 *    exercise history → Today reads Done.
 * 5. 'This hurts' offers Stop and gentler options and never push-through copy; 'I don't like this
 *    exercise' on the Romanian deadlift persists (SQL and Profile → Exercises), and next week's
 *    session no longer prescribes it.
 * Then a week 1 the real generator built (no fixture): a blank-1RM hybrid profile, Today → Build
 * my program → This week → Start week 1, and its first strength session started from
 * /workout?start=<lineage>: the RPE instruction, no invented weight, and one set in Postgres.
 *
 * Every /api/coach request is aborted and no agent run is recorded: core logging never needs the
 * AI. Every state is captured to test-results/screens/<project>/, the desktop window's under
 * desktop-chromium/, for the owner's review (M4 criterion 8). Journeys 1 and 5 run again in a
 * desktop window on Chromium, the one desktop engine (playwright.config.ts).
 * Serial: programs, workouts and the profile are the one owner's. The service worker is blocked
 * because the coach requests are aborted with page.route, which WebKit applies only without one.
 */
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { DB_NAME, STORES } from '../src/lib/client/workout/names';
import { BASELINE_INSTRUCTION } from '../src/lib/domain/training/describe';
import type { RestState, StopwatchState } from '../src/lib/domain/workout';
import { restRemaining } from '../src/lib/domain/workout/timers';
import { DESKTOP, expectNoSideScroll, isDesktopPage } from './desktop';
import { PROGRAM_TZ, seedProgram, type SeededProgram } from './program-support';
import {
	captureScreen,
	gotoHydrated,
	profileAction,
	query,
	resetTrainingProfile,
	SAME_ORIGIN
} from './support';
import { historyAfterDone, readOutbox } from './workout-support';

test.use({ timezoneId: PROGRAM_TZ, serviceWorkers: 'block' });
// Whole journeys through several screens and the real server: well past the default 30 s.
test.describe.configure({ timeout: 240_000 });

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test.afterAll(async () => {
	await resetTrainingProfile();
});

const STRENGTH = 'Lower body & pull';

/** What the pain copy must never say (as workout-pain.serial.e2e.ts and copy.test.ts). */
const PUSH_THROUGH =
	/push (through|on)|work through|power through|tough it out|keep going|no pain,? no gain|ignore (the )?pain|shake it off/i;

// ---- The screens ------------------------------------------------------------------------------

const todaySession = (page: Page, title: string) =>
	page.getByTestId('today-session').filter({ has: page.getByText(title, { exact: true }) });
const main = (page: Page) => page.getByTestId('workout-main');
const card = (page: Page) => main(page).getByTestId('exercise');
const heading = (page: Page) => card(page).getByRole('heading', { level: 2 });
const rows = (page: Page) => card(page).getByTestId('set');
const logger = (page: Page) => page.getByTestId('set-logger');
const loadField = (page: Page) => logger(page).getByTestId('logger-load').getByRole('spinbutton');
const amountField = (page: Page) =>
	logger(page).getByTestId('logger-amount').getByRole('spinbutton');
const rpe = (page: Page, label: string) =>
	logger(page).getByRole('radio', { name: label, exact: true });
const pill = (page: Page) => page.getByTestId('rest-timer');
const restTime = (page: Page) => pill(page).getByTestId('rest-time');
const headerStopwatch = (page: Page) => page.getByTestId('workout-header').getByTestId('stopwatch');
const actionsSheet = (page: Page) => page.getByTestId('exercise-actions-sheet');
const option = (page: Page, name: string) =>
	actionsSheet(page)
		.getByTestId('alternative')
		.filter({ has: page.getByText(name, { exact: true }) });
const painSheet = (page: Page) => page.getByTestId('pain-sheet');
const finishSheet = (page: Page) => page.getByTestId('finish-sheet');
const plates = (page: Page) => page.getByRole('dialog', { name: 'Plate calculator' });

/**
 * Every state is captured: the iPhone projects' under their own name, a desktop window's under
 * desktop-chromium/ (the plan's layout for the owner's review), after checking that nothing there
 * scrolls sideways. captureScreen reads only the project's name from the TestInfo it is given.
 */
async function shoot(page: Page, testInfo: TestInfo, name: string) {
	if (!isDesktopPage(page)) return captureScreen(page, testInfo, `strength-${name}`);
	await expectNoSideScroll(page);
	const desktop = { project: { name: 'desktop-chromium' } } as TestInfo;
	return captureScreen(page, desktop, `strength-${name}`);
}

/** Aborts every coach request: the journeys must work with the AI out of reach. */
async function withoutCoach(page: Page) {
	await page.route('**/api/coach/**', (route) => route.abort('blockedbyclient'));
}

/** No coach run was ever recorded: nothing reached the agent, from the browser or the server. */
async function expectNoCoachRuns() {
	expect(await query('select id from agent_runs')).toEqual([]);
}

/** Today, once it has read the device and saved today's kits (on idle). */
async function openToday(page: Page) {
	await gotoHydrated(page, '/today');
	await expect(page.locator('[data-testid="today-plan"][data-kits="saved"]')).toBeAttached({
		timeout: 10_000
	});
}

/** M3's 'workout-day' this week, with onboarding complete so Today lists its sessions. */
async function seedWorkoutDay(request: APIRequestContext): Promise<SeededProgram> {
	const seeded = await seedProgram(request, { fixture: 'workout-day', start: 'this_week' });
	await query('update athlete_profiles set onboarding_completed_at = now()');
	return seeded;
}

/** Today → Start workout on the strength session: the workout page on its first exercise. */
async function startFromToday(page: Page, testInfo: TestInfo, shot: string): Promise<string> {
	await openToday(page);
	const start = todaySession(page, STRENGTH).getByTestId('start-workout');
	await expect(start).toHaveText('Start workout');
	await shoot(page, testInfo, shot);
	await start.click();
	await expect(page).toHaveURL(/\/workout$/);
	await expect(heading(page)).toHaveText('Back squat');
	await expect
		.poll(async () => (await activeWorkout(page))?.id ?? null, { message: 'a workout in progress' })
		.not.toBeNull();
	return (await activeWorkout(page))!.id;
}

/** Next until the card shows `name`. */
async function goTo(page: Page, name: string) {
	for (let i = 0; i < 10 && (await heading(page).textContent())?.trim() !== name; i++) {
		await main(page).getByTestId('exercise-next').click();
	}
	await expect(heading(page)).toHaveText(name);
}

/** Previous until the card shows `name`. */
async function backTo(page: Page, name: string) {
	for (let i = 0; i < 10 && (await heading(page).textContent())?.trim() !== name; i++) {
		await main(page).getByTestId('exercise-prev').click();
	}
	await expect(heading(page)).toHaveText(name);
}

/** Opens the card's quick actions and picks one of them. */
async function act(page: Page, action: string) {
	await card(page).getByTestId('exercise-actions').click();
	await expect(actionsSheet(page)).toBeVisible();
	await actionsSheet(page).getByTestId(`action-${action}`).click();
}

/** Types a value into a stepper, as the owner does by tapping it. */
async function enter(page: Page, field: ReturnType<typeof loadField>, value: string) {
	await field.click();
	await field.fill(value);
	await field.press('Enter');
}

/** Every change has reached the server: the outbox is empty. */
const synced = (page: Page) =>
	expect
		.poll(() => readOutbox(page), { timeout: 15_000, message: 'the outbox drains' })
		.toEqual([]);

/** The page's main column again after a redirect, once its code has run. */
async function landed(page: Page, url: string | RegExp) {
	await expect(page).toHaveURL(url);
	await page.waitForLoadState('networkidle');
}

interface StoredWorkout {
	id: string;
	status: string;
	device: { rest: RestState | null; stopwatch: StopwatchState };
}

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
			const found = await new Promise<StoredWorkout[]>(
				(resolve) => (all.onsuccess = () => resolve(all.result))
			);
			db.close();
			return found.find((w) => w.status === 'in_progress') ?? null;
		},
		{ name: DB_NAME, store: STORES.workouts }
	);

/** The stored timers and what the page shows of them, read at one moment. */
const timersNow = (page: Page) =>
	page.evaluate(
		async ({ name, store }) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(name);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			const all = db.transaction(store, 'readonly').objectStore(store).getAll();
			const found = await new Promise<StoredWorkout[]>(
				(resolve) => (all.onsuccess = () => resolve(all.result))
			);
			db.close();
			const { device } = found.find((w) => w.status === 'in_progress')!;
			const text = (selector: string) => document.querySelector(selector)?.textContent?.trim();
			return {
				rest: device.rest,
				stopwatch: device.stopwatch,
				restShown: text('[data-testid="rest-timer"] [data-testid="rest-time"]') ?? null,
				stopwatchShown: text('[data-testid="workout-header"] [data-testid="stopwatch"]') ?? null,
				now: Date.now()
			};
		},
		{ name: DB_NAME, store: STORES.workouts }
	);

/** 'm:ss' or 'h:mm:ss' in milliseconds. */
const clockMs = (text: string | null) =>
	(text ?? '').split(':').reduce((total, part) => total * 60 + Number(part), 0) * 1000;

/** Postgres: the current version's number. */
const versionNumber = async () =>
	(await query<{ n: number }>('select max(number)::int as n from program_versions'))[0]!.n;

/** Postgres: the owner's exercise preferences. */
const preferences = () =>
	query<{ exercise: string; sentiment: string; source: string }>(
		'select exercise, sentiment, source from exercise_preferences order by exercise'
	);

// ---- Journey 1 --------------------------------------------------------------------------------

const J1 =
	'journey 1: Today → log with weight, reps and RPE → rest → plates → a machine swap → a refresh restores exactly → finish → History, exercise history and Done';

async function strengthJourney(page: Page, request: APIRequestContext, testInfo: TestInfo) {
	await withoutCoach(page);
	await seedWorkoutDay(request);
	let workoutId = '';
	const done: Record<string, string[]> = {};

	await test.step('1. Today → Start workout opens the strength session', async () => {
		workoutId = await startFromToday(page, testInfo, 'today-start');
		await synced(page);
		expect(await query('select status from workouts where client_id = $1', [workoutId])).toEqual([
			{ status: 'in_progress' }
		]);
	});

	await test.step('2. the top set: no invented weight, logged with weight, reps and RPE; the rest runs', async () => {
		await expect(logger(page)).toContainText('RPE 7');
		await expect(loadField(page)).toHaveAttribute('aria-valuenow', '0');
		await expect(logger(page).getByTestId('logger-load')).toContainText(BASELINE_INSTRUCTION);
		await expect(amountField(page)).toHaveAttribute('aria-valuenow', '5');
		await shoot(page, testInfo, 'top-set');

		await enter(page, loadField(page), '100');
		await rpe(page, '8').check();
		await logger(page).getByTestId('complete-set').click();
		await expect(rows(page).first()).toHaveAttribute('data-state', 'done');
		await expect(rows(page).first()).toContainText('100 kg × 5 reps · RPE 8');
		// The top set's 3:00 rest starts at once.
		await expect(pill(page)).toHaveAttribute('data-phase', 'running');
		await expect(restTime(page)).toHaveText(/^(3:00|2:5\d)$/);
		await shoot(page, testInfo, 'resting');
	});

	await test.step('2. the back-offs: worked out from today’s top set, each with its reps and RPE', async () => {
		for (const reps of ['5', '5', '4']) {
			await expect(logger(page).getByTestId('logger-load')).toContainText("From today's top set");
			await expect(loadField(page)).not.toHaveAttribute('aria-valuenow', '0');
			if (reps !== '5') await enter(page, amountField(page), reps);
			await rpe(page, '7').check();
			await logger(page).getByTestId('complete-set').click();
		}
		await expect(page.getByTestId('exercise-done')).toHaveText('All sets logged');
		await expect(rows(page)).toHaveText([
			/100 kg × 5 reps · RPE 8/,
			/[\d.]+ kg × 5 reps · RPE 7/,
			/[\d.]+ kg × 5 reps · RPE 7/,
			/[\d.]+ kg × 4 reps · RPE 7/
		]);
		done['Back squat'] = await rows(page).allTextContents();
		await shoot(page, testInfo, 'exercise-done');
	});

	await test.step('4. the plate calculator opens from a set, at its weight', async () => {
		const first = rows(page).first().getByTestId('set-plates');
		await first.click();
		await expect(plates(page)).toBeVisible();
		await expect(plates(page)).toContainText('Set 1 · Back squat');
		await expect(plates(page).getByRole('spinbutton', { name: 'Target weight' })).toHaveAttribute(
			'aria-valuenow',
			'100'
		);
		await expect(plates(page).getByTestId('plates-result')).toHaveText(/^25 · 15\s*kg per side$/);
		await shoot(page, testInfo, 'plates');
		await plates(page).getByRole('button', { name: 'Close' }).click();
		await expect(plates(page)).toBeHidden();
		await expect(first).toBeFocused();
	});

	await test.step('5. the leg press swapped as machine unavailable: today only, no preference, no new version', async () => {
		await goTo(page, 'Leg press');
		await act(page, 'machine_unavailable');
		await expect(
			actionsSheet(page).getByRole('heading', { name: 'Swap for this session' })
		).toBeVisible();
		await shoot(page, testInfo, 'machine-unavailable');
		await option(page, 'Hack squat').click();
		await expect(actionsSheet(page)).toBeHidden();
		await expect(heading(page)).toHaveText('Hack squat');
		await expect(card(page).getByTestId('slot-state')).toHaveText(
			/Swapped for this session\s*Instead of Leg press/
		);
		await enter(page, loadField(page), '120');
		await logger(page).getByTestId('complete-set').click();
		await expect(rows(page).first()).toContainText('120 kg × 10 reps');
		done['Hack squat'] = await rows(page).allTextContents();
		await shoot(page, testInfo, 'substituted');
		await synced(page);

		const swaps = await query<{ reason: string; to_key: string }>(
			`select s.reason, t.key as to_key
			   from workout_substitutions s
			   join workouts w on w.id = s.workout_id
			   join exercises t on t.id = s.to_exercise_id
			  where w.client_id = $1 and s.deleted_at is null`,
			[workoutId]
		);
		expect(swaps).toEqual([{ reason: 'equipment_unavailable', to_key: 'hack_squat' }]);
		expect(await preferences()).toEqual([]);
		expect(await versionNumber()).toBe(1);
	});

	await test.step('2. the A1/A2 superset: pull-up, then the plank, then the round’s rest', async () => {
		await goTo(page, 'Pull-up');
		await expect(logger(page).getByTestId('logger-load')).toContainText('Added weight');
		await rpe(page, '8').check();
		await logger(page).getByTestId('complete-set').click();
		// No rest inside a round: the partner is current at once.
		await expect(heading(page)).toHaveText('Plank');
		await expect(amountField(page)).toHaveValue('0:45');
		await shoot(page, testInfo, 'superset-a2');
		await logger(page).getByTestId('complete-set').click();
		await expect(heading(page)).toHaveText('Pull-up');
		await expect(pill(page)).toHaveAttribute('data-phase', 'running');
		await expect(restTime(page)).toHaveText(/^1:[2-3]\d$/);
		done['Pull-up'] = await rows(page).allTextContents();
		await shoot(page, testInfo, 'superset-rest');
	});

	await test.step('3 and 6. a refresh mid-workout restores the exercise, every set, the rest within 1 s and the stopwatch', async () => {
		const before = await timersNow(page);
		expect(before.rest).not.toBeNull();
		await page.reload();
		await expect(page.locator('main#main[data-ready]')).toBeAttached();
		await expect(heading(page)).toHaveText('Pull-up');
		await expect(rows(page)).toHaveText(done['Pull-up']!);
		await expect(restTime(page)).toBeVisible();
		await expect(headerStopwatch(page)).toBeVisible();

		const after = await timersNow(page);
		// The timers are the stored timestamps, untouched by the reload…
		expect(after.rest).toEqual(before.rest);
		expect(after.stopwatch).toEqual(before.stopwatch);
		// …and the pill shows what is left of the rest, to the second.
		const left = restRemaining(after.rest!, after.now);
		expect(Math.abs(clockMs(after.restShown) - left)).toBeLessThanOrEqual(1000);
		expect(clockMs(after.restShown)).toBeLessThanOrEqual(clockMs(before.restShown));
		expect(clockMs(after.stopwatchShown)).toBeGreaterThanOrEqual(clockMs(before.stopwatchShown));
		await shoot(page, testInfo, 'restored');

		for (const name of ['Hack squat', 'Back squat']) {
			await backTo(page, name);
			await expect(rows(page), name).toHaveText(done[name]!);
		}
	});

	await test.step('the resume bar: Minimise to Today, then Resume returns to the workout', async () => {
		await page.getByRole('link', { name: 'Minimise' }).click();
		await landed(page, /\/today$/);
		const bar = page.getByTestId('resume-bar');
		await expect(bar).toBeVisible({ timeout: 10_000 });
		await expect(page.getByTestId('resume-title')).toHaveText(STRENGTH);
		await shoot(page, testInfo, 'resume-bar');
		await page.getByTestId('resume-link').click();
		await expect(page).toHaveURL(/\/workout$/);
		await expect(heading(page)).toHaveText('Back squat');
	});

	await test.step('7. Finish: the summary, then Done stores the workout', async () => {
		await page.getByTestId('workout-menu-button').click();
		await page.getByTestId('workout-menu').getByTestId('menu-finish').click();
		await expect(finishSheet(page)).toBeVisible();
		await expect(finishSheet(page)).toContainText('planned sets are still open');
		await finishSheet(page).getByTestId('finish-anyway').click();
		await expect(page.getByTestId('workout-summary')).toBeVisible();
		await finishSheet(page).getByRole('radio', { name: '8', exact: true }).check();
		await shoot(page, testInfo, 'summary');
		await finishSheet(page).getByTestId('finish-done').click();
		await historyAfterDone(page);
		await landed(page, `/progress/workouts/${workoutId}`);
		await expect(page.getByTestId('workout-detail')).toBeVisible();

		const [row] = await query<{ status: string; session_rpe: number }>(
			'select status, session_rpe::float8 as session_rpe from workouts where client_id = $1',
			[workoutId]
		);
		expect(row).toEqual({ status: 'completed', session_rpe: 8 });
		const sets = await query<{ key: string; weight: number | null; reps: number | null }>(
			`select x.key, r.weight::float8 as weight, r.reps
			   from set_records r
			   join workouts w on w.id = r.workout_id
			   join exercises x on x.id = r.exercise_id
			  where w.client_id = $1 and not r.is_skipped
			  order by r.exercise_position, r.set_index`,
			[workoutId]
		);
		expect(sets.map((s) => s.key)).toEqual([
			'back_squat',
			'back_squat',
			'back_squat',
			'back_squat',
			'hack_squat',
			'pull_up',
			'plank'
		]);
		expect(sets[0]).toEqual({ key: 'back_squat', weight: 100, reps: 5 });
		expect(sets[4]).toEqual({ key: 'hack_squat', weight: 120, reps: 10 });
	});

	await test.step('8. History lists it; its detail opens Back squat’s exercise history', async () => {
		await gotoHydrated(page, '/progress/workouts');
		const listed = page.getByTestId('workout-row');
		await expect(listed).toHaveCount(1);
		await expect(listed).toContainText(STRENGTH);
		await shoot(page, testInfo, 'history');
		await listed.click();
		await landed(page, `/progress/workouts/${workoutId}`);
		const detail = page.getByTestId('workout-detail');
		await expect(detail).toBeVisible();
		// Minutes × RPE, whole: a raw fraction would push the page wider than the phone.
		await expect(detail.getByTestId('workout-stats')).toContainText(/Load\s*\d+ AU/);
		await shoot(page, testInfo, 'history-detail');

		await detail.getByTestId('exercise-history-open').filter({ hasText: 'Back squat' }).click();
		const sheet = page.getByTestId('exercise-history-sheet');
		await expect(sheet.getByRole('heading', { name: 'Back squat' })).toBeVisible();
		await expect(sheet.getByTestId('history-session')).toHaveCount(1);
		await expect(sheet.getByTestId('history-set')).toHaveCount(4);
		await expect(sheet.getByTestId('history-set').first()).toContainText('100 kg × 5 reps · RPE 8');
		await expect(sheet.getByTestId('history-best')).toContainText(/^Estimated 1RM · [\d.]+ kg/);
		await shoot(page, testInfo, 'exercise-history');
		await sheet.getByRole('button', { name: 'Close' }).click();
		await expect(sheet).toBeHidden();
	});

	await test.step('9. Today shows the session Done', async () => {
		await openToday(page);
		const doneLink = todaySession(page, STRENGTH).getByTestId('done-workout');
		await expect(doneLink).toHaveText('Done · View');
		await expect(doneLink).toHaveAttribute('href', `/progress/workouts/${workoutId}`);
		await expect(todaySession(page, STRENGTH).getByTestId('start-workout')).toHaveCount(0);
		await shoot(page, testInfo, 'today-done');
		await expectNoCoachRuns();
	});
}

// ---- Journey 5 --------------------------------------------------------------------------------

const J5 =
	"journey 5: This hurts offers Stop and gentler options, never push-through; I don't like this exercise persists and next week drops it";

async function preferenceJourney(page: Page, request: APIRequestContext, testInfo: TestInfo) {
	await withoutCoach(page);
	const seeded = await seedWorkoutDay(request);
	const nextWeek = seeded.sessions.filter((s) => s.title === STRENGTH)[1]!;
	expect(nextWeek.date > seeded.today).toBe(true);
	const workoutId = await startFromToday(page, testInfo, 'pain-today-start');

	await test.step('This hurts: Stop first, gentler options for the knee, never push-through', async () => {
		await goTo(page, 'Leg press');
		await act(page, 'pain');
		await expect(painSheet(page)).toBeVisible();
		// Where it hurts is folded under Add details (optional).
		await painSheet(page).getByTestId('pain-details-toggle').click();
		await painSheet(page)
			.getByTestId('pain-area')
			.getByRole('radio', { name: 'Knee', exact: true })
			.check();
		const choices = painSheet(page).locator(
			'[data-testid="pain-stop"], [data-testid="alternative"]'
		);
		await expect(choices.first()).toHaveAttribute('data-testid', 'pain-stop');
		await expect(painSheet(page).getByTestId('alternative').first()).toBeVisible();
		expect(await painSheet(page).getByTestId('alternative').count()).toBeGreaterThan(0);
		expect((await painSheet(page).innerText()).match(PUSH_THROUGH)).toBeNull();
		await shoot(page, testInfo, 'pain');

		await painSheet(page).getByTestId('pain-stop').click();
		await expect(painSheet(page)).toBeHidden();
		await backTo(page, 'Leg press');
		await expect(card(page).getByTestId('slot-state')).toHaveText('Stopped');
		expect((await main(page).innerText()).match(PUSH_THROUGH)).toBeNull();
		await shoot(page, testInfo, 'pain-stopped');
		await synced(page);
		const reports = await query<{ area: string; action: string }>(
			`select p.body_area as area, p.action
			   from pain_reports p join workouts w on w.id = p.workout_id
			  where w.client_id = $1 and p.deleted_at is null`,
			[workoutId]
		);
		expect(reports).toEqual([{ area: 'knee', action: 'stopped' }]);
	});

	let instead = '';
	await test.step("I don't like this exercise on the Romanian deadlift: asked, then a lasting dislike", async () => {
		await goTo(page, 'Romanian deadlift');
		await act(page, 'dislike');
		const first = actionsSheet(page).getByTestId('alternative').first();
		await expect(first).toBeVisible();
		await first.click();
		await expect(
			actionsSheet(page).getByRole('heading', { name: "Don't prescribe Romanian deadlift again?" })
		).toBeVisible();
		await shoot(page, testInfo, 'dislike-confirm');
		await actionsSheet(page).getByTestId('dislike-confirm').click();
		await expect(actionsSheet(page)).toBeHidden();
		await expect(heading(page)).not.toHaveText('Romanian deadlift');
		instead = (await heading(page).textContent())!.trim();
		await expect(card(page).getByTestId('slot-state')).toHaveText(
			/Won't be prescribed again\s*Instead of Romanian deadlift/
		);
		await shoot(page, testInfo, 'disliked');
		await synced(page);

		expect(await preferences()).toEqual([
			{ exercise: 'Romanian deadlift', sentiment: 'dislike', source: 'workout' }
		]);
		expect(await versionNumber()).toBe(2);
	});

	await test.step('next week’s session no longer prescribes it, and Profile → Exercises lists it', async () => {
		await gotoHydrated(page, `/train/session/${nextWeek.lineage}`);
		await expect(page.getByRole('heading', { level: 1 })).toHaveText(STRENGTH);
		await expect(page.getByRole('heading', { name: instead, exact: true })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Romanian deadlift', exact: true })).toHaveCount(
			0
		);
		await shoot(page, testInfo, 'next-week');

		await gotoHydrated(page, '/profile/exercises');
		await expect(page.getByTestId('dislikes').getByRole('listitem')).toHaveText([
			'Romanian deadlift'
		]);
		await shoot(page, testInfo, 'profile-dislikes');
		await expectNoCoachRuns();
	});
}

test(J1, async ({ page, request }, testInfo) => {
	await strengthJourney(page, request, testInfo);
});

test(J5, async ({ page, request }, testInfo) => {
	await preferenceJourney(page, request, testInfo);
});

// ---- A week 1 the generator built -------------------------------------------------------------

const general = (title: string, disciplines: string[]) => ({
	kind: 'general',
	title,
	disciplines,
	focus: title,
	measure: 'Train every planned week'
});

/** A hybrid profile with every 1RM blank (as build-program.serial.e2e.ts), then Finish. */
async function blankHybridProfile(request: APIRequestContext) {
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
	await profileAction(request, '/profile/schedule?/save', {
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
	});
	const finish = await request.post('/onboarding/review?/complete', {
		headers: { ...SAME_ORIGIN, accept: 'application/json', 'x-sveltekit-action': 'true' },
		multipart: { payload: '{}' }
	});
	expect(await finish.json()).toMatchObject({ type: 'redirect', location: '/today' });
}

/**
 * The current version's first strength session, and its first exercise with a top set. That is
 * week 1's on most days; a 'This week' start plans only today on (start.ts startDates), so on a
 * late Saturday or a Sunday week 1 may hold no strength session and this takes week 2's, still
 * the lift's first appearance and so still prescribed by RPE.
 */
async function firstStrengthSession() {
	const [session] = await query<{ id: string; lineage: string }>(
		`select s.id, s.lineage_id as lineage
		   from programs p
		   join program_version_weeks vw on vw.version_id = p.current_version_id
		   join program_weeks w on w.id = vw.week_id
		   join planned_sessions s on s.week_id = w.id
		  where exists (select 1 from planned_exercises pe where pe.session_id = s.id)
		  order by s.scheduled_on, s.order_in_day
		  limit 1`
	);
	expect(session, 'the program holds a strength session').toBeDefined();
	const [main] = await query<{ name: string; load_kind: string }>(
		`select x.name, sp.load_kind
		   from planned_exercises pe
		   join exercises x on x.id = pe.exercise_id
		   join set_prescriptions sp on sp.planned_exercise_id = pe.id and sp.role = 'top'
		  where pe.session_id = $1
		  order by pe.position, sp.position
		  limit 1`,
		[session!.id]
	);
	expect(main, 'the session has a main lift with a top set').toBeDefined();
	return { lineage: session!.lineage, main: main! };
}

test('a week 1 the generator built: its first strength session asks for a load by RPE, invents none, and a logged set reaches Postgres', async ({
	page,
	request
}, testInfo) => {
	await withoutCoach(page);
	await blankHybridProfile(request);

	await test.step('Today → Build my program → This week → Start week 1', async () => {
		await gotoHydrated(page, '/today');
		await page.getByTestId('today-build-cta').click();
		await expect(page.getByTestId('build-preview-ready')).toBeVisible({ timeout: 15_000 });
		await page
			.getByTestId('build-start-choice')
			.getByRole('radio', { name: /This week/ })
			.check();
		await expect(page.getByTestId('build-preview-ready')).toBeVisible({ timeout: 15_000 });
		await shoot(page, testInfo, 'generated-preview');
		await page.getByTestId('build-start').click();
		await landed(page, '/train');
		await expect(page.getByTestId('program-position')).toContainText('Week 1 of');
		expect(await versionNumber()).toBe(1);
	});

	const { lineage, main: lift } = await firstStrengthSession();
	// Blank 1RMs: the generator prescribes the main lift's top set by RPE, never a load.
	expect(lift.load_kind).toBe('rpe_based');

	await test.step('its first strength session starts from /workout?start=<lineage>', async () => {
		await page.goto(`/workout?start=${lineage}`);
		await expect(page).toHaveURL(/\/workout$/);
		await expect(page.locator('main#main[data-ready]')).toBeAttached();
		await expect(heading(page)).toBeVisible();
		await goTo(page, lift.name);
		await expect(logger(page)).toContainText(/RPE \d/);
		await expect(logger(page).getByTestId('logger-load')).toContainText(BASELINE_INSTRUCTION);
		await expect(loadField(page)).toHaveAttribute('aria-valuenow', '0');
		await expect(rows(page).filter({ hasText: / (kg|lb)\b/ })).toHaveCount(0);
		await shoot(page, testInfo, 'generated-top-set');
	});

	await test.step('one logged set reaches Postgres', async () => {
		await enter(page, loadField(page), '60');
		await rpe(page, '8').check();
		await logger(page).getByTestId('complete-set').click();
		await expect(rows(page).first()).toContainText('60 kg');
		await synced(page);
		const sets = await query<{ name: string; weight: number; rpe: number }>(
			`select x.name, r.weight::float8 as weight, r.rpe::float8 as rpe
			   from set_records r join exercises x on x.id = r.exercise_id
			  where not r.is_skipped`
		);
		expect(sets).toEqual([{ name: lift.name, weight: 60, rpe: 8 }]);
		await shoot(page, testInfo, 'generated-logged');
		await expectNoCoachRuns();
	});
});

test.describe('in a desktop window', () => {
	test.use(DESKTOP);
	test.skip(
		({ browserName }) => browserName !== 'chromium',
		'the desktop window is Chromium, the one desktop engine (playwright.config.ts)'
	);

	test(J1, async ({ page, request }, testInfo) => {
		await strengthJourney(page, request, testInfo);
	});

	test(J5, async ({ page, request }, testInfo) => {
		await preferenceJourney(page, request, testInfo);
	});
});
