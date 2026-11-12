/**
 * The M5 coach journeys end to end against Postgres (the M5 brief's Playwright list), on an iPhone
 * and on a desktop window, with the mock coach:
 * 1. How has my bench progressed: the answer's facts and their sources are the sets Postgres
 *    holds, and a source opens that workout in History.
 * 2. Change today's workout → Accept → Train's new version, with the coach's why.
 * 3. Reject with a reason: the next turn's get_coach_proposals carries it, and 'What the coach
 *    knows' lists it.
 * 4. A dislike said to the coach: in Profile → Exercises, and, accepted, out of next week.
 * 5. The leg press is taken during a workout: a substitution in that workout, no preference, and
 *    the same program version.
 * 6. Pain: M4's knee report is in 'What the coach knows'; 'My knee hurts when I squat', answered
 *    by the adversarial script, gets the safety block, and no banned phrase is anywhere on the
 *    page.
 * 7. The coach unavailable, while logging a set still reaches Postgres.
 * 8. A reload keeps the conversation and its proposal, in Coach and in the inbox.
 *
 * It also takes the coach's screenshot set for the owner's review (e2e/coach-screens.ts): each
 * journey step in both themes, and the designed states the owning specs capture at one viewport
 * only, at the other. scripts/coach-screens-index.ts builds the contact sheet from them.
 *
 * Serial: the coach, program and workout rows and the faults are the one owner's and the one
 * server's (e2e/coach-support.ts).
 */
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import { scanAdvice } from '../src/lib/domain/coach/safety';
import {
	COACH_TZ,
	lastRun,
	openThread,
	postTurn,
	query,
	resetCoach,
	seedCoach,
	setCoachFault
} from './coach-support';
import { coachScreen, LIGHT, type CoachScreenId } from './coach-screens';
import { DESKTOP, isDesktopPage } from './desktop';
import { PROGRAM_TZ } from './program-support';
import { captureScreen, gotoHydrated, trackConsoleErrors } from './support';
import { startFromKit } from './workout-start-support';
import { gotoWorkout } from './workout-support';

test.use({ timezoneId: COACH_TZ });

test.beforeEach(async ({ request }) => {
	await resetCoach(request);
});

test.afterEach(async ({ page, request }) => {
	await page.context().setOffline(false);
	await resetCoach(request);
});

const BENCH = 'How has my bench progressed this month?';
const CHANGE = 'Can we change today’s workout?';
const REPLACE = 'I hate Bulgarian split squats, so replace them';
const REASON = 'Lunges hurt my knee, keep the split squats for now';
const AFTER_REJECTING = 'I rejected that change';
const TAKEN = 'The leg press is taken';
const KNEE = 'My knee hurts when I squat';
/** What the adversarial script says and the output policy must never let through. */
const UNSAFE = ['push through', 'keep going', 'meniscus', 'tendinitis'];

const composer = (page: Page) => page.getByRole('form', { name: 'Message your coach' });
const message = (page: Page) => composer(page).getByRole('textbox', { name: 'Message' });
const answer = (page: Page) => page.getByTestId('live-answer').last();
const card = (page: Page) => page.getByTestId('proposal-card');
const cardButton = (page: Page, name: string) => card(page).getByRole('button', { name });
const cardState = (page: Page) => card(page).getByTestId('proposal-state');
const knows = (page: Page) => page.getByTestId('knows-sheet');
const sourceRows = (block: ReturnType<Page['getByTestId']>) =>
	block.getByRole('list', { name: 'Sources' }).getByRole('listitem');

/** Send `text` from the composer and wait for the whole answer. */
async function ask(page: Page, text: string) {
	await message(page).fill(text);
	await composer(page).getByRole('button', { name: 'Send' }).click();
	await expect(page).toHaveURL(/\/coach\/[0-9a-f-]{36}$/);
	// Drafting tools take longer than a tool's own time (WORKOUT_DRAFT_DELAY_MS is 12 s).
	await expect(composer(page).getByRole('button', { name: 'Send' })).toBeVisible({
		timeout: 40_000
	});
	await expect(answer(page)).not.toHaveAttribute('aria-busy', 'true');
}

const threadOf = (page: Page) => new URL(page.url()).pathname.split('/').at(-1)!;

/** 'What the coach knows', opened from Coach. */
async function openKnows(page: Page) {
	await gotoHydrated(page, '/coach');
	await page.getByRole('button', { name: 'What it knows' }).click();
	await expect(knows(page)).toBeVisible();
}

/**
 * Capture screen `id` at this page's viewport (e2e/coach-screens.ts names the file), in the dark
 * theme and, unless `light` is false, the light one. Waits on document.fonts.status, never
 * document.fonts.ready, which WebKit resolves only after load while a request is held: so with
 * `held` (a navigation held open) it skips captureScreen, which awaits fonts.ready, and saves the
 * screenshot itself, as coach-inbox.serial.e2e.ts does.
 */
async function shoot(
	page: Page,
	testInfo: TestInfo,
	id: CoachScreenId,
	{ light = true, held = false } = {}
) {
	const screen = coachScreen(id);
	const name = isDesktopPage(page) ? screen.desktop.name : screen.phone.name;
	await page.waitForFunction(() => document.fonts.status === 'loaded');
	if (held) {
		await page.screenshot({
			path: `test-results/screens/${testInfo.project.name}/${name}.png`,
			animations: 'disabled'
		});
		return;
	}
	await captureScreen(page, testInfo, name);
	if (!light) return;
	await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
	try {
		await captureScreen(page, testInfo, `${name}${LIGHT}`);
	} finally {
		await page.evaluate(() => delete document.documentElement.dataset.theme);
	}
}

interface StoredProposal {
	id: string;
	kind: string;
	title: string;
	rationale: string;
	status: string;
	decisionNote: string | null;
}

const proposals = () =>
	query<StoredProposal>(
		`select id::text, kind, title, rationale, status, decision_note as "decisionNote"
		from coach_proposals order by created_at`
	);

async function versions(programId: string): Promise<number> {
	const [row] = await query<{ n: number }>(
		'select count(*)::int as n from program_versions where program_id = $1',
		[programId]
	);
	return row!.n;
}

/** How often the program's current version plans `exerciseId` from `from` on. */
async function plannedFrom(programId: string, exerciseId: string, from: string): Promise<number> {
	const [row] = await query<{ n: number }>(
		`select count(*)::int as n from programs p
		join program_version_weeks pvw on pvw.version_id = p.current_version_id
		join planned_sessions ps on ps.week_id = pvw.week_id
		join planned_exercises pe on pe.session_id = ps.id
		where p.id = $1 and pe.exercise_id = $2 and ps.scheduled_on >= $3`,
		[programId, exerciseId, from]
	);
	return row!.n;
}

/** Each bench day in the owner's zone: its top set and the workout it was logged in. */
async function benchDays(exerciseId: string) {
	return query<{ day: string; top: number; workout: string }>(
		`select to_char(performed_at at time zone $2, 'YYYY-MM-DD') as day,
			max(weight)::float8 as top, min(workout_id::text) as workout
		from set_records
		where exercise_id = $1 and deleted_at is null and not is_warmup and not is_skipped
		group by 1 order by 1`,
		[exerciseId, COACH_TZ]
	);
}

/**
 * Each set the coach's stored answers cite, in order, with the block citing it: its day in the
 * owner's zone, weight and workout as Postgres holds them (null for an id it does not hold).
 */
async function citedSets() {
	return query<{ kind: string; day: string | null; weight: number | null; workout: string | null }>(
		`select b.block->>'kind' as kind,
			to_char(s.performed_at at time zone $1, 'YYYY-MM-DD') as day,
			s.weight::float8 as weight, s.workout_id::text as workout
		from coach_messages m
		cross join lateral jsonb_array_elements(m.display->'blocks') with ordinality as b(block, n)
		cross join lateral jsonb_array_elements(b.block->'sources') with ordinality as r(ref, k)
		left join set_records s on s.id::text = r.ref->>'id'
		where m.role = 'assistant' and m.display ? 'blocks' and r.ref->>'type' = 'set'
		order by m.seq, b.n, r.k`,
		[COACH_TZ]
	);
}

/** The swap's proposal, asked for as the composer would, open in its conversation. */
async function proposed(page: Page, request: APIRequestContext) {
	const turn = await postTurn(request, REPLACE);
	expect(turn.status).toBe(200);
	const started = turn.events.find((event) => event.type === 'run_started');
	if (started?.type !== 'run_started') throw new Error('the turn started');
	await openThread(page, started.threadId);
	await expect(cardButton(page, 'Accept')).toBeEnabled();
}

/** Every journey; each viewport's describe runs them all. */
function journeys() {
	test('journey 1: how has my bench progressed: the facts and their sources are the sets Postgres holds', async ({
		page,
		request
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		const seeded = await seedCoach(request, 'bench-month');
		await gotoHydrated(page, '/coach');
		await ask(page, BENCH);

		const days = await benchDays(seeded.exercises.bench_press!);
		expect(days, 'bench-month logs four sessions').toHaveLength(4);
		const [first, last] = [days[0]!, days.at(-1)!];
		const blocks = answer(page).getByTestId('answer-block');
		const facts = blocks.filter({ hasText: /^\s*Fact/ });
		await expect(facts).toHaveCount(2);
		await expect(facts.first()).toContainText(`${first.day}: top set ${first.top} kg × 5`);
		await expect(facts.last()).toContainText(`${last.day}: top set ${last.top} kg × 5`);
		// Each fact shows one source, the set it read: the day's top set Postgres holds, in the
		// workout it was logged in. The estimate cites sets of those workouts. A ref the answer
		// cites carries no workout, so a set's source is a row, not a link (sources.ts).
		await expect(sourceRows(facts.first())).toHaveCount(1);
		await expect(sourceRows(facts.last())).toHaveCount(1);
		const cited = await citedSets();
		const citedFacts = cited.filter((c) => c.kind === 'fact');
		expect(citedFacts).toHaveLength(2);
		expect(citedFacts[0]).toEqual({
			kind: 'fact',
			day: first.day,
			weight: first.top,
			workout: first.workout
		});
		expect(citedFacts[1]).toEqual({
			kind: 'fact',
			day: last.day,
			weight: last.top,
			workout: last.workout
		});
		const citedMetric = cited.filter((c) => c.kind === 'metric');
		expect(citedMetric.length).toBeGreaterThan(0);
		for (const set of citedMetric) expect(days.map((d) => d.workout)).toContain(set.workout);
		await expect(sourceRows(blocks.filter({ hasText: /^\s*Calculated/ }))).toHaveCount(
			citedMetric.length
		);
		await shoot(page, testInfo, 'journey-bench');
		expect(errors).toEqual([]);
	});

	test('journey 2: change today’s workout, Accept, and Train shows the new version with the why', async ({
		page,
		request
	}, testInfo) => {
		test.slow(); // the workout draft alone takes 12 s
		const seeded = await seedCoach(request, 'split-squat-week');
		await gotoHydrated(page, '/coach');
		await ask(page, CHANGE);

		await expect(card(page)).toBeVisible({ timeout: 20_000 });
		const [stored] = await proposals();
		expect(stored).toMatchObject({ kind: 'workout_update', status: 'proposed' });
		await expect(card(page).getByRole('heading', { level: 3 })).toHaveText(stored!.title);
		await expect(card(page).getByTestId('proposal-why')).toHaveText(stored!.rationale);
		expect(await versions(seeded.programId!)).toBe(1);
		await shoot(page, testInfo, 'journey-change-proposed');

		await cardButton(page, 'Accept').click();
		await expect(cardState(page)).toContainText('Applied as version 2');
		expect(await versions(seeded.programId!)).toBe(2);
		expect((await proposals())[0]).toMatchObject({ id: stored!.id, status: 'applied' });
		await shoot(page, testInfo, 'journey-change-applied');

		await card(page).getByRole('link', { name: 'View in Train' }).click();
		await expect(page).toHaveURL(/\/train\/history\/2$/);
		await expect(page.getByTestId('current-version')).toBeVisible();
		await expect(page.getByTestId('version-changes')).toContainText(stored!.rationale);
		await shoot(page, testInfo, 'journey-train-version');
	});

	test('journey 3: a rejection’s reason reaches the next turn’s get_coach_proposals and the memory panel', async ({
		page,
		request
	}, testInfo) => {
		const seeded = await seedCoach(request, 'split-squat-week');
		await gotoHydrated(page, '/coach');
		await ask(page, REPLACE);
		await expect(cardButton(page, 'Accept')).toBeEnabled();
		const [stored] = await proposals();

		await cardButton(page, 'Reject').click();
		const reject = page.getByRole('dialog', { name: 'Reject this change' });
		await reject.getByRole('textbox', { name: /Why not\?/ }).fill(REASON);
		await reject.getByTestId('decision-submit').click();
		await expect(reject).toBeHidden();
		await expect(cardState(page)).toContainText('Declined');
		expect((await proposals())[0]).toMatchObject({
			id: stored!.id,
			status: 'rejected',
			decisionNote: REASON
		});
		expect(await versions(seeded.programId!)).toBe(1);
		await shoot(page, testInfo, 'journey-rejected');

		await ask(page, AFTER_REJECTING);
		await expect(answer(page)).toContainText(REASON);
		await expect(answer(page)).toContainText('Understood');
		const run = await lastRun();
		const reads = await query<{ output: unknown }>(
			`select output from agent_tool_calls where run_id = $1 and name = 'get_coach_proposals'`,
			[run!.id]
		);
		expect(reads).toHaveLength(1);
		expect(JSON.stringify(reads[0]!.output)).toContain(REASON);
		await shoot(page, testInfo, 'journey-after-rejection');

		await openKnows(page);
		const rejected = page.getByTestId('knows-rejected');
		await expect(rejected).toContainText(stored!.title);
		await expect(rejected).toContainText(`Your reason: ${REASON}`);
		await shoot(page, testInfo, 'journey-knows-rejected');
	});

	test('journey 4: a dislike said to the coach is in Profile, and accepted, out of next week', async ({
		page,
		request
	}, testInfo) => {
		const seeded = await seedCoach(request, 'split-squat-week');
		const splitSquat = seeded.exercises.bulgarian_split_squat!;
		const nextWeek = addDays(seeded.weekStart, 7);
		expect(await plannedFrom(seeded.programId!, splitSquat, nextWeek)).toBeGreaterThan(0);

		await gotoHydrated(page, '/coach');
		await ask(page, REPLACE);
		const threadId = threadOf(page);
		await expect(answer(page)).toContainText('Noted that you dislike');
		expect(
			await query(
				'select exercise_id::text as "exerciseId", sentiment, source from exercise_preferences'
			)
		).toEqual([{ exerciseId: splitSquat, sentiment: 'dislike', source: 'coach' }]);

		await gotoHydrated(page, '/profile/exercises');
		await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
		await expect(
			page.getByRole('list', { name: 'Exercises you’d rather swap out', exact: true })
		).toContainText(/Bulgarian split squat/i);
		await shoot(page, testInfo, 'journey-dislike-profile');

		await openThread(page, threadId);
		await cardButton(page, 'Accept').click();
		await expect(cardState(page)).toContainText('Applied as version 2');
		expect(await plannedFrom(seeded.programId!, splitSquat, nextWeek)).toBe(0);
		await shoot(page, testInfo, 'journey-dislike-applied');
	});

	test('journey 6: the knee report is in the memory panel, and a pain message gets the safety block with no banned phrase', async ({
		page,
		request
	}, testInfo) => {
		await seedCoach(request, 'knee-pain');
		await openKnows(page);
		await expect(page.getByTestId('knows-pain')).toContainText('Back squat · Knee');
		await shoot(page, testInfo, 'journey-knows-pain');
		await knows(page).getByRole('button', { name: 'Close' }).click();
		await expect(knows(page)).toBeHidden();

		// The adversarial script tells the owner to carry on and names a diagnosis.
		await setCoachFault(request, 'none', { script: 'pain-unsafe' });
		await ask(page, KNEE);
		const safety = answer(page).locator('[data-testid="answer-block"][data-kind="safety"]').first();
		await expect(safety).toContainText('Stop the movement');
		await expect(safety).toContainText(/doctor or physiotherapist/);
		const noBannedPhrase = async () => {
			const shown = await page.locator('body').innerText();
			expect(scanAdvice(shown, { painContext: true })).toEqual([]);
			for (const said of UNSAFE) expect(shown.toLowerCase()).not.toContain(said);
		};
		await noBannedPhrase();
		await shoot(page, testInfo, 'journey-pain-safety');

		// What was stored says no more than what streamed.
		await page.reload();
		await expect(page.getByTestId('coach-message').last()).toContainText('Stop the movement');
		await noBannedPhrase();
	});

	test('journey 8: a reload keeps the conversation and its proposal, in Coach and in the inbox', async ({
		page,
		request
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await seedCoach(request, 'split-squat-week');
		await gotoHydrated(page, '/coach');
		await ask(page, REPLACE);
		await expect(cardButton(page, 'Accept')).toBeEnabled();
		const [stored] = await proposals();

		await page.reload();
		await expect(page.getByTestId('owner-message')).toHaveText(new RegExp(REPLACE));
		// Stored, the answer that made the proposal is its card, the note a footnote under it.
		await expect(page.getByTestId('answer-footnote')).toContainText('Noted that you dislike');
		await expect(card(page).getByRole('heading', { level: 3 })).toHaveText(stored!.title);
		await expect(cardButton(page, 'Accept')).toBeEnabled();
		await shoot(page, testInfo, 'journey-reloaded-thread');

		await page.getByTestId('all-conversations').click();
		await expect(page.getByTestId('thread-row')).toHaveCount(1);
		await expect(page.getByTestId('thread-row')).toContainText(REPLACE);
		await page.getByRole('link', { name: 'Proposals' }).click();
		await expect(page).toHaveURL(/\/coach\/proposals$/);
		const waiting = page.getByTestId('inbox-waiting').getByTestId('inbox-row');
		await expect(waiting).toHaveCount(1);
		await page.reload();
		await expect(waiting).toHaveCount(1);
		await expect(waiting).toContainText(stored!.title);
		await shoot(page, testInfo, 'journey-reloaded-inbox');

		expect(await query('select count(*)::int as n from coach_threads')).toEqual([{ n: 1 }]);
		expect((await proposals()).map((p) => p.status)).toEqual(['proposed']);
		expect(errors).toEqual([]);
	});

	test.describe('in a workout', () => {
		test.use({ timezoneId: PROGRAM_TZ });

		test('journey 5: the leg press is taken: a substitution in the workout, no preference, the same version', async ({
			page,
			request
		}, testInfo) => {
			test.slow(); // a workout started, a turn, and the workout reconciled
			const { workoutId, program } = await startFromKit(page, request);
			const [leg] = await query<{ id: string }>(
				`select id::text from exercises where key = 'leg_press' and owner_id is null`
			);

			// Asked from the workout: its Options sheet opens Coach about this workout.
			await page
				.getByTestId('workout-main')
				.getByTestId('exercise')
				.getByTestId('exercise-actions')
				.click();
			await page.getByTestId('exercise-actions-sheet').getByTestId('ask-coach').click();
			await expect(page).toHaveURL(/\/coach\?/);
			await expect(message(page)).toHaveValue(CHANGE);
			await ask(page, TAKEN);

			await expect(card(page)).toBeVisible({ timeout: 20_000 });
			await expect(card(page).getByRole('heading', { level: 3 })).toHaveText('Swap it for today');
			await shoot(page, testInfo, 'journey-taken-proposed');

			await cardButton(page, 'Accept').click();
			await expect(cardState(page)).toContainText('Applied');
			const swaps = await query<{ from: string; to: string; reason: string; workout: string }>(
				`select ws.from_exercise_id::text as "from", ws.to_exercise_id::text as "to", ws.reason,
					w.client_id::text as workout
				from workout_substitutions ws join workouts w on w.id = ws.workout_id`
			);
			expect(swaps).toEqual([
				{
					from: leg!.id,
					to: expect.any(String),
					reason: 'equipment_unavailable',
					workout: workoutId
				}
			]);
			expect(await query('select 1 from exercise_preferences')).toEqual([]);
			expect(await versions(program.programId)).toBe(1);
			expect((await proposals()).map((p) => p.status)).toEqual(['applied']);
			await shoot(page, testInfo, 'journey-taken-applied');

			// The workout, reconciled with the server on opening, shows the swap (Up next names it).
			const [swapped] = await query<{ name: string }>('select name from exercises where id = $1', [
				swaps[0]!.to
			]);
			await gotoWorkout(page, 'strength', { sync: 'real' });
			await expect(page.locator('main#main')).toContainText(swapped!.name, { timeout: 15_000 });
			await shoot(page, testInfo, 'journey-taken-workout');
		});

		test('journey 7: the coach unavailable, while a set logged in the workout reaches Postgres', async ({
			page,
			request
		}, testInfo) => {
			const { workoutId } = await startFromKit(page, request);
			await setCoachFault(request, 'unavailable');
			await gotoHydrated(page, '/coach');
			await expect(page.getByTestId('coach-unavailable')).toContainText('The coach is unavailable');
			await shoot(page, testInfo, 'journey-unavailable');

			await gotoWorkout(page, 'strength', { sync: 'real' });
			// The kit invents no weight (the squat is set by RPE), so the set needs the one used.
			const load = page
				.getByTestId('set-logger')
				.getByTestId('logger-load')
				.getByRole('spinbutton');
			await load.click();
			await load.fill('100');
			await load.press('Enter');
			await page.getByTestId('set-logger').getByTestId('complete-set').click();
			await expect(page.getByTestId('workout-main').getByTestId('set').first()).toHaveAttribute(
				'data-state',
				'done'
			);
			await expect
				.poll(
					async () =>
						(
							await query<{ n: number }>(
								`select count(*)::int as n from set_records s join workouts w on w.id = s.workout_id
								where w.client_id = $1`,
								[workoutId]
							)
						)[0]!.n,
					{ message: 'the set reaches Postgres', timeout: 15_000 }
				)
				.toBe(1);
			await shoot(page, testInfo, 'journey-unavailable-logged');
		});
	});
}

/** The states this spec captures at both viewports: no owning spec captures them. */
function ownStates() {
	test('switched off: its notice', async ({ page, request }, testInfo) => {
		await setCoachFault(request, 'disabled');
		await gotoHydrated(page, '/coach');
		await expect(page.getByTestId('coach-unavailable')).toContainText('The coach is switched off');
		await shoot(page, testInfo, 'disabled', { light: false });
	});

	test.describe('with the network in the test’s hands', () => {
		// page.route never sees a request from a page the service worker controls on WebKit.
		test.use({ serviceWorkers: 'block' });

		test('opening a conversation: busy until it renders', async ({ page, request }, testInfo) => {
			const seeded = await seedCoach(request, 'bench-month');
			await gotoHydrated(page, '/coach');
			const release = await hold(page, `**/coach/${seeded.threads.bench}/__data.json*`);
			await page.getByTestId('thread-row').first().click();
			await expect(page.getByTestId('coach-loading')).toContainText('Loading the conversation…');
			await shoot(page, testInfo, 'thread-loading', { held: true });
			release();
			await expect(page.getByTestId('coach-loading')).toHaveCount(0);
		});
	});
}

/** Hold requests matching `url` until the returned release. */
async function hold(page: Page, url: string | ((url: URL) => boolean)) {
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route(url, async (route) => {
		await held;
		await route.continue().catch(() => undefined);
	});
	return release;
}

/** Answer the first request matching `url` with a 500, after `held` if given; the rest go through. */
async function failOnce(page: Page, url: string | ((url: URL) => boolean), held?: Promise<void>) {
	let answered = 0;
	await page.route(url, async (route) => {
		answered += 1;
		if (answered > 1) return route.continue();
		await held;
		return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
	});
}

const THREAD_ACTION = (url: URL) => url.pathname.startsWith('/api/coach/threads/');
const THREAD_LIST = (url: URL) => url.pathname === '/api/coach/threads';
const BENCH_THREAD = 'How is my bench press going?';
const NEWEST_ARCHIVED = 'Can I run the day after heavy squats?';
/** A sheet's loading and failed screens, by its test ids' prefix. */
const SHEET_STATES = {
	knows: ['memory-loading', 'memory-failed'],
	usage: ['usage-loading', 'usage-failed'],
	archived: ['archived-loading', 'archived-failed']
} as const satisfies Record<string, readonly [CoachScreenId, CoachScreenId]>;

test.describe('on an iPhone', () => {
	journeys();
	ownStates();
});

test.describe('on a desktop window', () => {
	test.use(DESKTOP);
	journeys();
	ownStates();

	test.describe('the states other specs capture on an iPhone only', () => {
		// page.route never sees a request from a page the service worker controls on WebKit.
		test.use({ serviceWorkers: 'block' });

		test('the empty states', async ({ page }, testInfo) => {
			await gotoHydrated(page, '/coach');
			await expect(page.getByTestId('coach-empty')).toContainText('No conversations yet');
			await shoot(page, testInfo, 'coach-empty', { light: false });

			await page.getByRole('button', { name: 'What it knows' }).click();
			await expect(page.getByTestId('knows-empty')).toContainText(
				'The coach doesn’t know much yet'
			);
			await shoot(page, testInfo, 'memory-empty', { light: false });

			await gotoHydrated(page, '/coach');
			await page.getByRole('button', { name: 'Usage', exact: true }).click();
			await expect(page.getByTestId('usage-empty')).toContainText('No coach runs yet');
			await shoot(page, testInfo, 'usage-empty', { light: false });

			await gotoHydrated(page, '/coach');
			await page.getByTestId('archived-link').click();
			await expect(page.getByTestId('archived-empty')).toContainText('No archived conversations');
			await shoot(page, testInfo, 'archived-empty', { light: false });

			await gotoHydrated(page, '/coach/proposals');
			await expect(page.getByTestId('inbox-empty')).toContainText('No proposals yet');
			await shoot(page, testInfo, 'inbox-empty', { light: false });
		});

		test('a proposal offline, and an inbox filter with nothing in it', async ({
			page,
			request
		}, testInfo) => {
			await seedCoach(request, 'split-squat-week');
			await proposed(page, request);
			await page.context().setOffline(true);
			await expect(card(page).getByTestId('proposal-offline')).toContainText('You’re offline');
			await shoot(page, testInfo, 'proposal-offline', { light: false });
			await page.context().setOffline(false);

			await gotoHydrated(page, '/coach/proposals?show=decided');
			await expect(page.getByTestId('inbox-filter-empty')).toContainText('Nothing decided yet');
			await shoot(page, testInfo, 'inbox-filter-empty', { light: false });
		});

		test('a long answer, behind Show all', async ({ page, request }, testInfo) => {
			const seeded = await seedCoach(request, 'bench-month');
			await setCoachFault(request, 'none', { script: 'many-blocks' });
			await openThread(page, seeded.threads.bench!);
			await ask(page, 'Give me the whole plan');
			await expect(answer(page).getByTestId('show-all-blocks')).toBeVisible();
			await shoot(page, testInfo, 'long-answer', { light: false });
		});

		test('an answer stopped, then one interrupted by leaving', async ({
			page,
			request
		}, testInfo) => {
			const seeded = await seedCoach(request, 'bench-month');
			await setCoachFault(request, 'slow');
			const ended = page.getByTestId('answer-ended');
			const begin = async () => {
				await openThread(page, seeded.threads.bench!);
				await message(page).fill(BENCH);
				await composer(page).getByRole('button', { name: 'Send' }).click();
				await expect(answer(page).getByTestId('answer-draft')).not.toBeEmpty();
			};
			await begin();
			await composer(page).getByRole('button', { name: 'Stop' }).click();
			await expect(ended.last()).toHaveText('Stopped');
			await shoot(page, testInfo, 'stopped', { light: false });

			await begin();
			await page
				.getByRole('navigation', { name: 'Primary' })
				.getByRole('link', { name: 'Today' })
				.click();
			await expect.poll(async () => (await lastRun())?.status).toBe('interrupted');
			await setCoachFault(request, 'none');
			await openThread(page, seeded.threads.bench!);
			await expect(ended.last()).toHaveText('Interrupted');
			await shoot(page, testInfo, 'interrupted', { light: false });
		});

		test('Thinking…', async ({ page, request }, testInfo) => {
			const seeded = await seedCoach(request, 'bench-month');
			await setCoachFault(request, 'none', { script: 'thinking-pause' });
			await openThread(page, seeded.threads.bench!);
			await message(page).fill('Is my week on track?');
			await composer(page).getByRole('button', { name: 'Send' }).click();
			await expect(page.getByTestId('thinking')).toHaveText(/Thinking…/);
			await shoot(page, testInfo, 'thinking', { light: false });
			await expect(composer(page).getByRole('button', { name: 'Send' })).toBeVisible({
				timeout: 20_000
			});
		});

		for (const [what, url, open, prefix] of [
			[
				'What the coach knows',
				'**/api/coach/memory',
				(page: Page) => page.getByRole('button', { name: 'What it knows' }).click(),
				'knows'
			],
			[
				'Usage',
				'**/api/coach/runs*',
				(page: Page) => page.getByRole('button', { name: 'Usage', exact: true }).click(),
				'usage'
			],
			[
				'Archived conversations',
				THREAD_LIST,
				(page: Page) => page.getByTestId('archived-link').click(),
				'archived'
			]
		] as const) {
			const [loading, failed] = SHEET_STATES[prefix];
			test(`${what}: loading, then failed with Retry`, async ({ page, request }, testInfo) => {
				await seedCoach(request, 'archived-threads');
				let release!: () => void;
				await failOnce(page, url, new Promise<void>((resolve) => (release = resolve)));
				await gotoHydrated(page, '/coach');
				await open(page);
				await expect(page.getByTestId(`${prefix}-loading`)).toHaveAttribute('aria-busy', 'true');
				await shoot(page, testInfo, loading, { light: false });
				release();
				const notice = page.getByTestId(`${prefix}-failed`);
				await expect(notice.getByRole('button', { name: 'Retry' })).toBeVisible();
				await shoot(page, testInfo, failed, { light: false });
			});
		}

		test('rename: saving, then failed with Retry', async ({ page, request }, testInfo) => {
			await seedCoach(request, 'bench-month');
			let release!: () => void;
			await failOnce(page, THREAD_ACTION, new Promise<void>((resolve) => (release = resolve)));
			await gotoHydrated(page, '/coach');
			await page.getByRole('button', { name: `Manage ${BENCH_THREAD}` }).click();
			const sheet = page.getByTestId('manage-sheet');
			await sheet.getByRole('textbox', { name: 'Name' }).fill('Bench block');
			const save = sheet.getByRole('button', { name: 'Save name' });
			await save.click();
			await expect(save).toHaveAttribute('aria-busy', 'true');
			await shoot(page, testInfo, 'rename-pending', { light: false });
			release();
			await expect(page.getByTestId('rename-failed')).toContainText('That didn’t go through');
			await shoot(page, testInfo, 'rename-failed', { light: false });
		});

		test('an unarchive that failed, with Retry on its row', async ({ page, request }, testInfo) => {
			await seedCoach(request, 'archived-threads');
			await failOnce(page, THREAD_ACTION);
			await gotoHydrated(page, '/coach');
			await page.getByTestId('archived-link').click();
			const row = page.getByTestId('archived-row').first();
			await row.getByRole('button', { name: `Unarchive ${NEWEST_ARCHIVED}` }).click();
			await expect(row.getByTestId('unarchive-failed')).toContainText('That didn’t go through');
			await shoot(page, testInfo, 'unarchive-failed', { light: false });
		});

		// The load's own soft failure, as coach-screen.serial.e2e.ts sends it: a 200 whose page data
		// is { failed: true } (devalue's flattened form).
		test('a conversation whose load failed, with Retry', async ({ page, request }, testInfo) => {
			const seeded = await seedCoach(request, 'bench-month');
			await gotoHydrated(page, '/coach');
			await page.route(
				`**/coach/${seeded.threads.bench}/__data.json*`,
				async (route) => {
					const response = await route.fetch();
					const body = (await response.json()) as { nodes: { data: unknown }[] };
					body.nodes.at(-1)!.data = [
						{ coach: 1, prefill: 4, failed: 3 },
						{ status: 2, mockBadge: 3 },
						'ready',
						true,
						null
					];
					await route.fulfill({ response, json: body });
				},
				{ times: 1 }
			);
			await page.getByTestId('thread-row').first().click();
			await expect(page.getByTestId('load-failed')).toContainText(
				'Couldn’t load your conversations'
			);
			await shoot(page, testInfo, 'load-failed', { light: false });
		});

		test('an Accept that failed: Couldn’t save, with Retry', async ({
			page,
			request
		}, testInfo) => {
			await seedCoach(request, 'split-squat-week');
			await proposed(page, request);
			await failOnce(page, '**/api/coach/proposals/*');
			await cardButton(page, 'Accept').click();
			await expect(card(page).getByTestId('proposal-failure')).toContainText('Couldn’t save');
			await shoot(page, testInfo, 'decision-failed', { light: false });
		});

		test('exercise history: failed, then offline', async ({ page, context, request }, testInfo) => {
			const seeded = await seedCoach(request, 'bench-month');
			await openThread(page, seeded.threads.bench!);
			const source = page
				.getByTestId('coach-message')
				.getByRole('list', { name: 'Sources' })
				.getByRole('button', { name: 'Bench press, Exercise', exact: true });
			const sheet = page.getByTestId('exercise-history-sheet');
			await failOnce(page, '**/api/exercises/*/history*');
			await source.click();
			await expect(sheet.getByTestId('exercise-history-error')).toContainText(
				'Couldn’t load this history'
			);
			await shoot(page, testInfo, 'exercise-sheet-error', { light: false });
			await sheet.getByRole('button', { name: 'Close' }).click();
			await expect(sheet).toBeHidden();

			await context.setOffline(true);
			await source.click();
			await expect(sheet.getByTestId('exercise-history-offline')).toContainText(
				'Exercise history needs a connection'
			);
			await shoot(page, testInfo, 'exercise-sheet-offline', { light: false });
		});
	});
});
