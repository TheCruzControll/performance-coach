/**
 * Core workout logging never needs the coach (PRD §15; M5 brief: "core logging works with the
 * coach disabled or failing"). With the coach failing ('error': every model call is a server
 * error), then unavailable ('unavailable': no key, which still answers lookups directly), then not
 * launched ('not_launched': production's state until coach-launch), a whole workout runs against
 * the real server: Today → Start workout → three logged sets → the leg press swapped as machine
 * unavailable → Finish. Postgres holds the result, and none of the workout pages, Today, Train or
 * History sends a single /api/coach request or records an agent run. Only then the Coach tab, which
 * shows the notice that matches the fault; under 'unavailable' today's workout is still answered,
 * directly, with the session just finished.
 *
 * Faults are injected through the test-only route (e2e/coach-support.ts); no request is held or
 * faked, so the coach really is failing for the server. The not_launched case runs again in a
 * desktop window on Chromium, the one desktop engine (playwright.config.ts).
 * Serial: the program, the workout, the coach rows and the faults are the one owner's and the one
 * server's. The service worker is blocked, as in journey-strength.serial.e2e.ts, so every request
 * the pages send is the page's own and is counted here, on WebKit too.
 */
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { resetCoach, setCoachFault, type CoachFault } from './coach-support';
import { DESKTOP, expectNoSideScroll, isDesktopPage } from './desktop';
import { PROGRAM_TZ, seedProgram } from './program-support';
import { captureScreen, gotoHydrated, query } from './support';
import { readOutbox } from './workout-support';

test.use({ timezoneId: PROGRAM_TZ, serviceWorkers: 'block' });
// A whole workout through several screens and the real server: well past the default 30 s.
test.describe.configure({ timeout: 240_000 });

test.beforeEach(async ({ request }) => {
	await resetCoach(request);
});

test.afterEach(async ({ request }) => {
	await resetCoach(request);
});

/** The session M3's 'workout-day' fixture plans for today. */
const STRENGTH = 'Lower body & pull';
/** A lookup the coach answers without a model call (domain/coach/intents.ts). */
const TODAY_LOOKUP = 'What’s today’s workout?';
/** A question only the model can answer. */
const QUESTION = 'How is my squat going?';

// ---- The screens ------------------------------------------------------------------------------

const todaySession = (page: Page) =>
	page.getByTestId('today-session').filter({ has: page.getByText(STRENGTH, { exact: true }) });
const main = (page: Page) => page.getByTestId('workout-main');
const card = (page: Page) => main(page).getByTestId('exercise');
const heading = (page: Page) => card(page).getByRole('heading', { level: 2 });
const rows = (page: Page) => card(page).getByTestId('set');
const logger = (page: Page) => page.getByTestId('set-logger');
const loadField = (page: Page) => logger(page).getByTestId('logger-load').getByRole('spinbutton');
const actionsSheet = (page: Page) => page.getByTestId('exercise-actions-sheet');
const finishSheet = (page: Page) => page.getByTestId('finish-sheet');
const composer = (page: Page) => page.getByRole('form', { name: 'Message your coach' });
const message = (page: Page) => composer(page).getByRole('textbox', { name: 'Message' });
const coachNotice = (page: Page) => page.getByTestId('coach-unavailable');
const turnNotice = (page: Page) => page.getByTestId('turn-notice');
const nav = (page: Page) => page.getByRole('navigation', { name: 'Primary' });

/** Every state is captured, a desktop window's under desktop-chromium/, for the owner's review. */
async function shoot(page: Page, testInfo: TestInfo, name: string) {
	await expectNoSideScroll(page);
	const info = isDesktopPage(page)
		? ({ project: { name: 'desktop-chromium' } } as TestInfo)
		: testInfo;
	return captureScreen(page, info, `coach-degrade-${name}`);
}

/** Every change has reached the server: the outbox is empty. */
const synced = (page: Page) =>
	expect
		.poll(() => readOutbox(page), { timeout: 15_000, message: 'the outbox drains' })
		.toEqual([]);

/** Every /api/coach request the page sends from now on, by path. */
function countCoachRequests(page: Page): string[] {
	const sent: string[] = [];
	page.on('request', (request) => {
		const { pathname } = new URL(request.url());
		if (pathname.startsWith('/api/coach')) sent.push(`${request.method()} ${pathname}`);
	});
	return sent;
}

/** Types a value into a stepper, as the owner does by tapping it. */
async function enter(page: Page, value: string) {
	const field = loadField(page);
	await field.click();
	await field.fill(value);
	await field.press('Enter');
}

/** Ask the coach, then wait for the turn to end (Send is back). */
async function ask(page: Page, text: string) {
	await message(page).fill(text);
	await composer(page).getByRole('button', { name: 'Send' }).click();
	await expect(composer(page).getByRole('button', { name: 'Send' })).toBeVisible({
		timeout: 20_000
	});
}

// ---- The workout ------------------------------------------------------------------------------

/** Today → Start workout → three sets → a machine swap → Finish: the workout's client id. */
async function logWorkout(page: Page, testInfo: TestInfo, fault: CoachFault): Promise<string> {
	await gotoHydrated(page, '/today');
	const start = todaySession(page).getByTestId('start-workout');
	await expect(start).toHaveText('Start workout');
	await start.click();
	await expect(page).toHaveURL(/\/workout$/);
	await expect(heading(page)).toHaveText('Back squat');

	await enter(page, '100');
	await logger(page).getByRole('radio', { name: '8', exact: true }).check();
	await logger(page).getByTestId('complete-set').click();
	for (let set = 2; set <= 3; set++) {
		await expect(rows(page).nth(set - 2)).toHaveAttribute('data-state', 'done');
		await logger(page).getByRole('radio', { name: '7', exact: true }).check();
		await logger(page).getByTestId('complete-set').click();
	}
	await expect(rows(page).nth(2)).toHaveAttribute('data-state', 'done');
	await expect(rows(page).first()).toContainText('100 kg × 5 reps · RPE 8');
	await shoot(page, testInfo, `${fault}-logged`);

	for (let i = 0; i < 10 && (await heading(page).textContent())?.trim() !== 'Leg press'; i++) {
		await main(page).getByTestId('exercise-next').click();
	}
	await expect(heading(page)).toHaveText('Leg press');
	await card(page).getByTestId('exercise-actions').click();
	await actionsSheet(page).getByTestId('action-machine_unavailable').click();
	await actionsSheet(page)
		.getByTestId('alternative')
		.filter({ has: page.getByText('Hack squat', { exact: true }) })
		.click();
	await expect(actionsSheet(page)).toBeHidden();
	await expect(heading(page)).toHaveText('Hack squat');
	await expect(card(page).getByTestId('slot-state')).toHaveText(
		/Swapped for this session\s*Instead of Leg press/
	);
	await shoot(page, testInfo, `${fault}-substituted`);
	await synced(page);
	const [active] = await query<{ id: string }>(
		`select client_id::text as id from workouts where status = 'in_progress'`
	);
	expect(active, 'the workout in progress reached Postgres').toBeDefined();

	await page.getByTestId('workout-menu-button').click();
	await page.getByTestId('workout-menu').getByTestId('menu-finish').click();
	await expect(finishSheet(page)).toBeVisible();
	await finishSheet(page).getByTestId('finish-anyway').click();
	await expect(page.getByTestId('workout-summary')).toBeVisible();
	await finishSheet(page).getByRole('radio', { name: '8', exact: true }).check();
	await finishSheet(page).getByTestId('finish-done').click();
	await expect(page).toHaveURL(`/progress/workouts/${active!.id}`);
	await expect(page.getByTestId('workout-detail')).toBeVisible();
	return active!.id;
}

/** Postgres holds the finished workout: its three sets and its swap, and nothing else. */
async function expectStored(workoutId: string) {
	const [workout] = await query<{ status: string; session_rpe: number }>(
		'select status, session_rpe::float8 as session_rpe from workouts where client_id = $1',
		[workoutId]
	);
	expect(workout).toEqual({ status: 'completed', session_rpe: 8 });
	const sets = await query<{ key: string; weight: number; reps: number }>(
		`select x.key, r.weight::float8 as weight, r.reps
		   from set_records r
		   join workouts w on w.id = r.workout_id
		   join exercises x on x.id = r.exercise_id
		  where w.client_id = $1 and not r.is_skipped
		  order by r.exercise_position, r.set_index`,
		[workoutId]
	);
	expect(sets.map((s) => s.key)).toEqual(['back_squat', 'back_squat', 'back_squat']);
	expect(sets[0]).toEqual({ key: 'back_squat', weight: 100, reps: 5 });
	const swaps = await query<{ reason: string; to_key: string }>(
		`select s.reason, t.key as to_key
		   from workout_substitutions s
		   join workouts w on w.id = s.workout_id
		   join exercises t on t.id = s.to_exercise_id
		  where w.client_id = $1 and s.deleted_at is null`,
		[workoutId]
	);
	expect(swaps).toEqual([{ reason: 'equipment_unavailable', to_key: 'hack_squat' }]);
}

/** Today reads Done, Train and History list the workout: the rest of the app works. */
async function expectAppWorks(
	page: Page,
	testInfo: TestInfo,
	fault: CoachFault,
	workoutId: string
) {
	await nav(page).getByRole('link', { name: 'Today' }).click();
	await expect(page.getByRole('heading', { level: 1 })).toContainText('Today');
	await expect(todaySession(page).getByTestId('done-workout')).toHaveAttribute(
		'href',
		`/progress/workouts/${workoutId}`
	);
	await nav(page).getByRole('link', { name: 'Train' }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Train' })).toBeVisible();
	await gotoHydrated(page, '/progress/workouts');
	await expect(page.getByTestId('workout-row')).toHaveCount(1);
	await expect(page.getByTestId('workout-row')).toContainText(STRENGTH);
	await shoot(page, testInfo, `${fault}-history`);
}

// ---- The Coach tab, per fault -----------------------------------------------------------------

/** What the Coach tab shows under each fault this spec puts in force. */
const COACH_TAB = {
	/** Failing: no notice until a question needs the model, which ends on the coach-side notice. */
	error: async (page: Page) => {
		await expect(coachNotice(page)).toHaveCount(0);
		await ask(page, QUESTION);
		await expect(turnNotice(page)).toContainText('The coach service had a problem');
		await expect.poll(async () => (await lastRunStatus()) ?? 'none').toBe('failed');
	},
	/** Unavailable (no key): the notice, and today's workout still answered, without a model. */
	unavailable: async (page: Page) => {
		await expect(coachNotice(page)).toContainText('The coach is unavailable');
		await expect(message(page)).toBeEnabled();
		await ask(page, TODAY_LOOKUP);
		const answer = page.getByTestId('coach-message').or(page.getByTestId('live-answer'));
		await expect(answer.last()).toContainText(STRENGTH);
		await expect(answer.last()).toContainText('(done)');
		await expect(turnNotice(page)).toHaveCount(0);
		expect(await query('select provider from agent_runs')).toEqual([{ provider: 'direct' }]);
	},
	/** Not launched: the getting-ready notice and a disabled composer. */
	not_launched: async (page: Page) => {
		await expect(coachNotice(page)).toContainText('Your coach is getting ready');
		await expect(message(page)).toBeDisabled();
	}
} satisfies Partial<Record<CoachFault, (page: Page) => Promise<void>>>;

type DegradedFault = keyof typeof COACH_TAB;

const lastRunStatus = async () =>
	(
		await query<{ status: string }>(
			'select status from agent_runs order by started_at desc, id desc limit 1'
		)
	)[0]?.status;

async function degradedWorkout(
	page: Page,
	request: APIRequestContext,
	testInfo: TestInfo,
	fault: DegradedFault
) {
	await seedProgram(request, { fixture: 'workout-day', start: 'this_week' });
	await query('update athlete_profiles set onboarding_completed_at = now()');
	await setCoachFault(request, fault);
	const coachRequests = countCoachRequests(page);

	let workoutId = '';
	await test.step('a whole workout: started, three sets logged, substituted, finished', async () => {
		workoutId = await logWorkout(page, testInfo, fault);
	});
	await test.step('Postgres holds the result', async () => {
		await expectStored(workoutId);
	});
	await test.step('Today, Train and History work', async () => {
		await expectAppWorks(page, testInfo, fault, workoutId);
	});
	await test.step('nothing reached the coach: no /api/coach request, no agent run', async () => {
		expect(coachRequests).toEqual([]);
		expect(await query('select id from agent_runs')).toEqual([]);
	});
	await test.step('the Coach tab shows the matching notice', async () => {
		await nav(page).getByRole('link', { name: 'Coach' }).click();
		await expect(page).toHaveURL(/\/coach/);
		await page.waitForLoadState('networkidle');
		await COACH_TAB[fault](page);
		await shoot(page, testInfo, `${fault}-coach`);
	});
}

for (const fault of [
	'error',
	'unavailable',
	'not_launched'
] as const satisfies readonly DegradedFault[]) {
	test(`${fault}: a whole workout is logged and finished, Today, Train and History work, and Coach says why`, async ({
		page,
		request
	}, testInfo) => {
		await degradedWorkout(page, request, testInfo, fault);
	});
}

test.describe('in a desktop window', () => {
	test.use(DESKTOP);
	test.skip(
		({ browserName }) => browserName !== 'chromium',
		'the desktop window is Chromium, the one desktop engine (playwright.config.ts)'
	);

	test('not_launched: a whole workout is logged and finished, and Coach says it is getting ready', async ({
		page,
		request
	}, testInfo) => {
		await degradedWorkout(page, request, testInfo, 'not_launched');
	});
});
