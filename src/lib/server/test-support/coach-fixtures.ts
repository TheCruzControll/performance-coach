/**
 * Coach fixtures for the M5 journeys and their integration test, written through the real
 * services at dates the server works out from the owner's today (ownerToday), so a browser test
 * never computes a date of its own:
 * - training history through M4's sync dispatcher (applySyncBatch), as a device sends it
 * - a program through M3's store (createProgramFromPlan)
 * - conversations through runTurn itself, with a MockProvider playing the fixture's answers, so a
 *   stored thread is exactly what a real turn stores (its memory preamble, turn context, run and
 *   model call) and a journey can continue it
 *
 * The fixtures:
 * - bench-month: four weekly bench sessions (3 × 5 at 80, 82.5, 85 and 87.5 kg, the last one
 *   yesterday), and a thread whose answer cites [[exercise:<bench id>|Bench press]]
 * - split-squat-week: M3's workout-day program from this Monday, with Bulgarian split squats in
 *   place of the leg press, today and a week from today
 * - run-weeks: the four weeks before this one, each with an easy run (Tuesday) and a long run
 *   (Saturday) growing from 10 to 13 km
 * - long-thread: one thread of LONG_THREAD_EXCHANGES questions and answers
 * - knee-pain: yesterday's synced 'Leg day', two squat sets and a knee pain report, then finished
 * - archived-threads: three archived threads
 * - unpriced-run: a thread whose answer was served by UNPRICED_MODEL, a model PRICING does not
 *   list, so its cost is unknown and the cap counts it at the highest rate
 *
 * The test route's faults (COACH_FAULTS, applyCoachFault) are here too, because two of them write
 * and routes never reach the database.
 *
 * A seed starts from an owner with no conversation, program or workout (e2e/coach-support.ts
 * resets first); on top of any it is refused with CoachSeedConflictError and writes nothing.
 * TEST ONLY: used by /api/test-support/coach (404 unless test routes are enabled) and by
 * tests/integration/coach/test-support.test.ts, never by app code.
 */
import { eq, sql } from 'drizzle-orm';
import { addDays, mondayOf, type IsoDate } from '../../domain/calendar';
import { DAILY_LIMITS } from '../../domain/coach/budgets';
import { PRICING } from '../../domain/coach/pricing';
import type { ProgramPlan } from '../../domain/training/types';
import { createMutation, type Mutation } from '../../domain/workout/index';
import { clearMockOverrides, setMockOverrides, type MockOverrides } from '../agent/provider/faults';
import { MockProvider, type MockScript } from '../agent/provider/mock';
import { COACH_MODEL } from '../agent/provider/types';
import { runTurn } from '../agent/turn';
import { RATE_LIMITS } from '../auth/policy';
import { authRateLimits, createAuthRepository, getDb, type Executor } from '../db';
import { ownerToday } from '../local-date';
import { finishRun, recordModelCall, startRun } from '../services/coach/runs';
import { archiveThread, startOwnerTurn, THREAD_VIEW_MESSAGES } from '../services/coach/threads';
import { resolveKeys } from '../services/exercises/index';
import { getAthleteProfile, saveBasics } from '../services/profile/index';
import { createProgramFromPlan } from '../services/programs/index';
import { applySyncBatch } from '../services/workouts/sync';
import { atLocal } from './analytics-fixtures/dashboards';
import { programFixture } from './program-fixtures';

export const COACH_FIXTURES = [
	'bench-month',
	'split-squat-week',
	'run-weeks',
	'long-thread',
	'knee-pain',
	'archived-threads',
	'unpriced-run'
] as const;
export type CoachFixture = (typeof COACH_FIXTURES)[number];

export const isCoachFixture = (name: unknown): name is CoachFixture =>
	COACH_FIXTURES.includes(name as CoachFixture);

/**
 * long-thread's questions: one more than a page of the thread view holds, so 'Show older' has an
 * older page (16 questions, 32 shown messages, 49 stored). Each is a real turn of about 33
 * queries, so this keeps the seed under a second; 30 (60 shown messages) takes about 1.2 s.
 */
export const LONG_THREAD_EXCHANGES = THREAD_VIEW_MESSAGES / 2 + 1;
/** The model unpriced-run's answer was served by: in no PRICING row. */
export const UNPRICED_MODEL = 'claude-future-x';

export interface SeededCoach {
	fixture: CoachFixture;
	timeZone: string;
	/** The owner's today in `timeZone` when the fixture was seeded, and its week's Monday. */
	today: IsoDate;
	weekStart: IsoDate;
	programId: string | null;
	/** Catalogue key → exercise id, for every exercise the fixture logs or plans. */
	exercises: Record<string, string>;
	/** Workout client ids by name. */
	workouts: Record<string, string>;
	/** Thread ids by name; archived-threads' are archived1 to archived3. */
	threads: Record<string, string>;
}

/** The owner already has a conversation, a program or a workout: reset first. Nothing was written. */
export class CoachSeedConflictError extends Error {
	constructor() {
		super('The owner already has coach threads, a program or workouts: reset before seeding');
		this.name = 'CoachSeedConflictError';
	}
}

interface Ctx {
	ownerId: string;
	timeZone: string;
	now: Date;
	today: IsoDate;
	weekStart: IsoDate;
	db: Executor;
}

type Result = Partial<Pick<SeededCoach, 'programId' | 'exercises' | 'workouts' | 'threads'>>;

const MINUTE = 60_000;

// ---- conversations ----------------------------------------------------------------------------

interface Exchange {
	ask: string;
	answer: string;
	/** A fallback model served the answer. */
	servedBy?: string;
}

/**
 * One thread of `exchanges`, each a real turn answered by the mock, a minute apart and ending
 * `endsMinutesAgo` before now. The test route's overrides never reach this provider.
 */
async function converse(ctx: Ctx, exchanges: readonly Exchange[], endsMinutesAgo = 0) {
	const scripts: MockScript[] = exchanges.map((each, index) => ({
		name: `fixture-${index}`,
		matches: (text) => text === each.ask,
		steps: [{ text: each.answer, ...(each.servedBy && { fallback: { model: each.servedBy } }) }]
	}));
	const provider = new MockProvider(scripts, { overrides: () => ({}) });
	let threadId: string | null = null;
	for (const [index, each] of exchanges.entries()) {
		const at = new Date(
			ctx.now.getTime() - (endsMinutesAgo + exchanges.length - 1 - index) * MINUTE
		);
		const turn = runTurn(
			{
				ownerId: ctx.ownerId,
				threadId,
				clientMessageId: crypto.randomUUID(),
				text: each.ask,
				signal: new AbortController().signal
			},
			{ provider: { status: 'ready', provider }, deps: { db: ctx.db, now: () => at } }
		);
		let answered = false;
		for await (const event of turn) {
			if (event.type === 'run_started') threadId = event.threadId;
			if (event.type === 'answer_completed') answered = true;
		}
		if (!answered || !threadId) throw new Error(`Coach fixture turn '${each.ask}' did not answer`);
	}
	return threadId!;
}

// ---- training ---------------------------------------------------------------------------------

async function exerciseIds<K extends string>(ctx: Ctx, keys: readonly K[]) {
	const found = await resolveKeys(keys, { db: ctx.db });
	return Object.fromEntries(keys.map((key) => [key, found.get(key)!.id])) as Record<K, string>;
}

/** Apply mutations as the sync endpoint does; anything not applied is a broken fixture. */
async function sync(ctx: Ctx, mutations: readonly Mutation[]) {
	const raw = JSON.parse(JSON.stringify(mutations)) as Record<string, unknown>[];
	const { results } = await applySyncBatch(ctx.ownerId, raw, { db: ctx.db, now: () => ctx.now });
	const refused = results.filter((result) => result.status !== 'applied');
	if (refused.length > 0) throw new Error(`Coach fixture sync refused: ${JSON.stringify(refused)}`);
}

const instant = (date: Date, minutes = 0) =>
	new Date(date.getTime() + minutes * MINUTE).toISOString();

/** An ad-hoc workout: started at `start`, then `body`'s mutations, finished `durationSeconds` on. */
function workout(
	start: Date,
	what: {
		kind: 'strength' | 'run';
		title: string;
		sessionType: 'strength' | 'easy_run' | 'long_run';
	},
	body: (workoutId: string, at: (minutes: number) => string) => Mutation[],
	durationSeconds: number
): { id: string; mutations: Mutation[] } {
	const workoutId = crypto.randomUUID();
	const at = (minutes: number) => instant(start, minutes);
	const discipline = what.kind === 'run' ? 'running' : 'strength';
	const plan = { plannedSessionId: null, plannedLineage: null, programId: null };
	const finishedAt = Math.ceil(durationSeconds / 60);
	return {
		id: workoutId,
		mutations: [
			createMutation('workout.start', {
				workoutId,
				at: at(0),
				payload: { ...what, discipline, ...plan }
			}),
			...body(workoutId, at),
			createMutation('workout.finish', {
				workoutId,
				at: at(finishedAt),
				payload: { durationSeconds, sessionRpe: 7 }
			})
		]
	};
}

const setLog = (
	workoutId: string,
	at: string,
	set: { exerciseId: string; setIndex: number; weight: number; reps: number; rpe: number }
) =>
	createMutation('set.log', {
		workoutId,
		at,
		payload: {
			position: 1,
			plannedLineage: null,
			...set,
			seconds: null,
			metres: null,
			assistance: null,
			unit: 'kg',
			missedReps: 0,
			isWarmup: false,
			isExtra: false
		}
	});

// ---- the fixtures -----------------------------------------------------------------------------

const BENCH_KG = [80, 82.5, 85, 87.5];

const benchMonth = async (ctx: Ctx): Promise<Result> => {
	const ids = await exerciseIds(ctx, ['bench_press']);
	const workouts: Record<string, string> = {};
	for (const [index, weight] of BENCH_KG.entries()) {
		const day = addDays(ctx.today, 7 * (index - BENCH_KG.length + 1) - 1);
		const sets = (id: string, at: (minutes: number) => string) =>
			[1, 2, 3].map((setIndex) =>
				setLog(id, at(5 * setIndex), {
					exerciseId: ids.bench_press,
					setIndex,
					weight,
					reps: 5,
					rpe: 8
				})
			);
		const what = { kind: 'strength', title: 'Bench', sessionType: 'strength' } as const;
		const done = workout(atLocal(day, '07:00', ctx.timeZone), what, sets, 1800);
		await sync(ctx, done.mutations);
		workouts[`bench${index + 1}`] = done.id;
	}
	const bench = await converse(ctx, [
		{
			ask: 'How is my bench press going?',
			answer: `Your bench has gone up every week this month.\n\n[recommendation] Keep adding 2.5 kg a week to your [[exercise:${ids.bench_press}|Bench press]] while every set stays at RPE 8 or below.`
		}
	]);
	return { exercises: ids, workouts, threads: { bench } };
};

const splitSquatWeek = async (ctx: Ctx): Promise<Result> => {
	const plan = programFixture('workout-day', { monday: ctx.weekStart, today: ctx.today });
	const swapped: ProgramPlan = {
		...plan,
		blocks: plan.blocks.map((block) => ({
			...block,
			weeks: block.weeks.map((week) => ({
				...week,
				sessions: week.sessions.map((session) =>
					session.kind !== 'strength'
						? session
						: {
								...session,
								exercises: session.exercises.map((each) =>
									'key' in each.exercise && each.exercise.key === 'leg_press'
										? { ...each, exercise: { key: 'bulgarian_split_squat' } }
										: each
								)
							}
				)
			}))
		}))
	};
	const { programId } = await createProgramFromPlan(
		ctx.ownerId,
		swapped,
		{ source: 'rules' },
		{ db: ctx.db }
	);
	return { programId, exercises: await exerciseIds(ctx, ['bulgarian_split_squat']) };
};

const runWeeks = async (ctx: Ctx): Promise<Result> => {
	const workouts: Record<string, string> = {};
	for (let week = 1; week <= 4; week++) {
		const monday = addDays(ctx.weekStart, 7 * (week - 5));
		const runs = [
			{ day: 1, sessionType: 'easy_run', title: 'Easy run', metres: 6000, seconds: 2160 },
			{
				day: 5,
				sessionType: 'long_run',
				title: 'Long run',
				metres: 9000 + 1000 * week,
				seconds: 330 * (9 + week)
			}
		] as const;
		for (const run of runs) {
			const what = { kind: 'run', title: run.title, sessionType: run.sessionType } as const;
			const log = (id: string, at: (minutes: number) => string) => [
				createMutation('run.log', {
					workoutId: id,
					at: at(Math.ceil(run.seconds / 60)),
					payload: { distanceMetres: run.metres, durationSeconds: run.seconds, rpe: 5 }
				})
			];
			const start = atLocal(addDays(monday, run.day), '07:00', ctx.timeZone);
			const done = workout(start, what, log, run.seconds);
			await sync(ctx, done.mutations);
			workouts[`${run.sessionType === 'easy_run' ? 'easy' : 'long'}${week}`] = done.id;
		}
	}
	return { workouts };
};

const longThread = async (ctx: Ctx): Promise<Result> => {
	const exchanges = Array.from({ length: LONG_THREAD_EXCHANGES }, (_, index) => ({
		ask: `Question ${index + 1}: what should I focus on in session ${index + 1}?`,
		answer: `[note] Answer ${index + 1}: keep session ${index + 1} steady and log every set.`
	}));
	return { threads: { long: await converse(ctx, exchanges) } };
};

const kneePain = async (ctx: Ctx): Promise<Result> => {
	const ids = await exerciseIds(ctx, ['back_squat']);
	const what = { kind: 'strength', title: 'Leg day', sessionType: 'strength' } as const;
	const start = atLocal(addDays(ctx.today, -1), '18:00', ctx.timeZone);
	const body = (id: string, at: (minutes: number) => string) => [
		setLog(id, at(5), { exerciseId: ids.back_squat, setIndex: 1, weight: 100, reps: 5, rpe: 7 }),
		setLog(id, at(10), { exerciseId: ids.back_squat, setIndex: 2, weight: 100, reps: 5, rpe: 8 }),
		createMutation('pain.report', {
			workoutId: id,
			at: at(12),
			payload: {
				position: 1,
				plannedLineage: null,
				exerciseId: ids.back_squat,
				area: 'knee',
				severity: 'moderate',
				action: 'ended_workout',
				substitutionId: null,
				note: 'Sharp at the bottom of the squat'
			}
		})
	];
	const done = workout(start, what, body, 900);
	await sync(ctx, done.mutations);
	return { exercises: ids, workouts: { legDay: done.id } };
};

const archivedThreads = async (ctx: Ctx): Promise<Result> => {
	const asks = [
		'Should I take a lighter week soon?',
		'How much protein should I eat?',
		'Can I run the day after heavy squats?'
	];
	const threads: Record<string, string> = {};
	for (const [index, ask] of asks.entries()) {
		const answer = `[note] Archived answer ${index + 1}: it depends on how your week has gone.`;
		const id = await converse(ctx, [{ ask, answer }], 10 * (asks.length - index));
		await archiveThread(ctx.ownerId, id, { db: ctx.db });
		threads[`archived${index + 1}`] = id;
	}
	return { threads };
};

const unpricedRun = async (ctx: Ctx): Promise<Result> => {
	const unpriced = await converse(ctx, [
		{
			ask: 'Can you suggest a mobility routine?',
			answer: '[note] Ten minutes of hips and ankles before each session is a good start.',
			servedBy: UNPRICED_MODEL
		}
	]);
	return { threads: { unpriced } };
};

const FIXTURES: Record<CoachFixture, (ctx: Ctx) => Promise<Result>> = {
	'bench-month': benchMonth,
	'split-squat-week': splitSquatWeek,
	'run-weeks': runWeeks,
	'long-thread': longThread,
	'knee-pain': kneePain,
	'archived-threads': archivedThreads,
	'unpriced-run': unpricedRun
};

async function holdsData(db: Executor, ownerId: string): Promise<boolean> {
	const { rows } = await db.execute<{ held: boolean }>(
		sql`select exists (select 1 from coach_threads where owner_id = ${ownerId})
			or exists (select 1 from programs where owner_id = ${ownerId})
			or exists (select 1 from workouts where owner_id = ${ownerId}) as held`
	);
	return rows[0]!.held;
}

/**
 * Seed fixture `name` for `ownerId`: record `timeZone` (and kg and km) on the profile, take today
 * from it at `now`, then run the fixture.
 */
export async function seedCoachFixture(
	ownerId: string,
	name: CoachFixture,
	options: { timeZone: string; now?: Date },
	deps: { db?: Executor } = {}
): Promise<SeededCoach> {
	const db = deps.db ?? getDb();
	const now = options.now ?? new Date();
	if (await holdsData(db, ownerId)) throw new CoachSeedConflictError();
	const { name: owner } = await getAthleteProfile(ownerId, { db });
	const basics = { name: owner || 'Niko', weightUnit: 'kg', distanceUnit: 'km' };
	await saveBasics(ownerId, { ...basics, timeZone: options.timeZone }, { db });
	const today = await ownerToday(ownerId, now, { db });
	const ctx: Ctx = {
		ownerId,
		timeZone: options.timeZone,
		now,
		today,
		weekStart: mondayOf(today),
		db
	};
	const result = await FIXTURES[name](ctx);
	return {
		fixture: name,
		timeZone: ctx.timeZone,
		today,
		weekStart: ctx.weekStart,
		programId: result.programId ?? null,
		exercises: result.exercises ?? {},
		workouts: result.workouts ?? {},
		threads: result.threads ?? {}
	};
}

// ---- faults -----------------------------------------------------------------------------------

/**
 * What each fault does to the next turns (POST /api/test-support/coach {fault}). Its overrides
 * replace whatever was set before; two faults also write:
 * - rate_limited counts coach turns up to RATE_LIMITS['coach.turn'], so POST /api/coach/turns
 *   answers 429 with Retry-After; every other fault (none included) clears that count
 * - budget spends today's DAILY_LIMITS, so a turn ends with a budget error; only a reset undoes it
 * - error and overloaded fail every model call (the turn ends with a provider error)
 * - unavailable is the no_key misconfiguration: lookups are still answered directly, anything
 *   else gets the unavailable error. Owner decision (test default): 'mock_in_production' here
 *   would show the other misconfiguration, which behaves the same.
 * - not_launched and disabled refuse every turn and write nothing, as production does
 * - refusal and slow play the mock scripts of those names (mock-scripts/test.ts)
 */
export const COACH_FAULTS = {
	none: {},
	error: { fault: { kind: 'server_error' } },
	overloaded: { fault: { kind: 'overloaded' } },
	rate_limited: {},
	unavailable: { unavailable: 'no_key' },
	not_launched: { unavailable: 'not_launched' },
	disabled: { unavailable: 'disabled' },
	refusal: { script: 'refusal' },
	slow: { script: 'slow' },
	budget: {}
} as const satisfies Record<string, MockOverrides>;
export type CoachFault = keyof typeof COACH_FAULTS;

export const isCoachFault = (value: unknown): value is CoachFault =>
	typeof value === 'string' && Object.hasOwn(COACH_FAULTS, value);

/**
 * Put `fault` in force for the owner's next turns, with `controls` (a forced script, a chunk
 * delay, a shorter turn) over its overrides; returns the overrides now in force.
 */
export async function applyCoachFault(
	ownerId: string,
	fault: CoachFault,
	controls: Pick<MockOverrides, 'script' | 'chunkDelayMs' | 'turnMs'> = {},
	deps: { db?: Executor } = {}
): Promise<MockOverrides> {
	const db = deps.db ?? getDb();
	clearMockOverrides();
	if (fault === 'rate_limited') await exhaustTurnRateLimit(db);
	else await clearTurnRateLimit(db);
	if (fault === 'budget') await spendDailyCap(ownerId, { db });
	const overrides = { ...COACH_FAULTS[fault], ...controls };
	setMockOverrides(overrides);
	return overrides;
}

/** The counter enforceRateLimit keeps for coach turns (auth/rate-limit.ts, subject 'global'). */
export const TURN_RATE_KEY = 'coach.turn:global';

/** Count coach turns up to RATE_LIMITS['coach.turn'], so the next turn is a 429. */
export async function exhaustTurnRateLimit(db: Executor = getDb(), now = new Date()) {
	const { limit, windowMs } = RATE_LIMITS['coach.turn'];
	const repo = createAuthRepository(db);
	let hits = 0;
	while (hits < limit) hits = await repo.hitRateLimit(TURN_RATE_KEY, windowMs, now);
}

/** Forget the coach turns counted, so the next turn is allowed. */
export async function clearTurnRateLimit(db: Executor = getDb()) {
	await db.delete(authRateLimits).where(eq(authRateLimits.key, TURN_RATE_KEY));
}

/** The archived thread spendDailyCap stores its spend on. */
export const BUDGET_THREAD_TEXT = 'Test support: today’s coach budget, spent';

/**
 * Spend today's DAILY_LIMITS on a finished run of COACH_MODEL output, so the next turn is out of
 * budget. Its thread (an owner message, no answer) is archived, out of Recent. Only a reset
 * (resetCoach) undoes it: the coach's rows are never deleted.
 */
export async function spendDailyCap(
	ownerId: string,
	deps: { db?: Executor; now?: () => Date } = {}
) {
	const promptVersion = 'test-support';
	const { thread, message } = await startOwnerTurn(
		ownerId,
		{
			clientMessageId: crypto.randomUUID(),
			text: BUDGET_THREAD_TEXT,
			segment: { promptVersion, programVersionId: null }
		},
		deps
	);
	const run = await startRun(
		ownerId,
		{
			threadId: thread.id,
			triggerMessageId: message.id,
			kind: 'turn',
			provider: 'mock',
			model: COACH_MODEL,
			effort: 'medium',
			promptVersion
		},
		deps
	);
	const outputTokens = Math.ceil(DAILY_LIMITS.costMicros / PRICING[COACH_MODEL]!.output);
	const usage = { inputTokens: 0, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
	const call = { index: 0, requestId: null, model: COACH_MODEL, stopReason: 'end_turn' };
	await recordModelCall(
		ownerId,
		run.id,
		{ ...call, usage, ttftMs: null, latencyMs: 0, error: null },
		deps
	);
	await finishRun(ownerId, run.id, { status: 'completed' }, deps);
	await archiveThread(ownerId, thread.id, deps);
}
