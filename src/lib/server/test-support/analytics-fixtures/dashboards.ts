/**
 * The dashboard fixtures (M6): new-user, first-week and twelve-weeks, each written through the
 * real services at dates counted from the owner's today (SeedContext).
 *
 * - new-user: the profile's basics only. No program, no log.
 * - first-week: the hybrid profile and a program that starts this Monday, with every session
 *   dated before today logged as planned.
 * - twelve-weeks: the hybrid profile and a 14-week program from 12 weeks before this Monday, its
 *   input stored as the origin snapshot (as a build stores it). Weeks 1–12 are complete, week 13
 *   is this week (logged up to yesterday) and week 14 is ahead. Each week plans Strength A
 *   (Mon), Intervals and a Muay Thai class (Tue), Strength B (Wed), a tempo run (Thu) and a long
 *   run (Sat). The numbers follow the formulas below, so a spec can work any week out by hand:
 *   - squat 3 × 5 at 100 + 2.5(n − 1) kg, RPE 8, after a 60 kg warm-up: rising
 *   - bench 3 × 5 at BENCH[n − 1], RPE BENCH_RPE[n − 1]: flat and noisy; a measured 1RM of
 *     100 kg on the profile
 *   - deadlift 2 × 5 at 140 + 2.5(n − 1) kg, RPE 8, except 190 kg at RPE 9 in week 7: the outlier
 *   - dumbbell curl 3 × 10 at 14 kg, RPE 8, every week: the stalled accessory
 *   - intervals 7300 m in 2330 − 4n s, four 800 m reps in 200 − n s each; tempo 7500 m in
 *     2400 − 5n s, its 5000 m tempo segment in 1500 − 5n s; long run 9000 + 1000n m at 330 s/km
 *   - heart rate on the long run from week 5, on the intervals and tempo from week 9
 *   - Muay Thai 90 min at RPE 7, 6 + (n mod 3) rounds, plus 2 sparring rounds in even weeks
 *   - a recovery note every Monday; a 10 km race result on the profile in week 8
 *   - week 6's tempo run skipped, week 7's long run moved to the Sunday, an off-plan recovery
 *     run (5 km, 30 min) on week 9's Friday
 *   - week 10's Strength B abandoned after two 230 kg deadlifts (so missed), a completed
 *     off-plan 'Arms' session on week 11's Friday that is then soft-deleted, and a workout in
 *     progress since 20 minutes ago with two 150 kg squats. Each keeps live sets heavy enough to
 *     top every strength figure if it were ever counted.
 */
import { addDays, type IsoDate } from '../../../domain/calendar';
import { CATALOGUE } from '../../../domain/exercises/index';
import { buildProgrammingInput, catalogueDigest, GENERATOR_ID } from '../../../domain/programming';
import type {
	BlockPlan,
	PlannedExercisePlan,
	ProgramPlan,
	RunSegment,
	SessionPlan,
	SetPrescription,
	WeekPlan
} from '../../../domain/training/types';
import type { SessionType } from '../../../domain/training/vocabulary';
import { workouts } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { resolveKeys } from '../../services/exercises/index';
import {
	createGoal,
	getTrainingProfile,
	saveBaselines,
	saveSchedule,
	saveSpecifics
} from '../../services/profile/index';
import {
	createProgramFromPlan,
	getProgramVersion,
	moveSession,
	skipSession,
	type StoredSession
} from '../../services/programs/index';
import {
	finishWorkout,
	logOtherSession,
	logRun,
	logSet,
	recordRecoveryNote,
	startWorkout
} from '../../services/training/log';
import type { AnalyticsFixture, FixtureResult, SeedContext } from './index';

/** Complete weeks of history before this week, and the program's weeks in all. */
export const HISTORY_WEEKS = 12;
const PROGRAM_WEEKS = HISTORY_WEEKS + 2;

const KEYS = [
	'back_squat',
	'bench_press',
	'barbell_row',
	'deadlift',
	'overhead_press',
	'dumbbell_curl'
] as const;
type Key = (typeof KEYS)[number];

/** Week n's bench (n from 1): flat and noisy, around 80 kg. */
export const BENCH = [80, 82.5, 77.5, 80, 85, 77.5, 80, 82.5, 75, 80, 82.5, 80, 80];
export const BENCH_RPE = [8, 8.5, 7.5, 8, 9, 7.5, 8, 8.5, 6.5, 8, 8.5, 8, 8];

const squatKg = (n: number) => 100 + 2.5 * (n - 1);
const deadliftKg = (n: number) => (n === 7 ? 190 : 140 + 2.5 * (n - 1));
const rowKg = (n: number) => 60 + 2.5 * Math.floor((n - 1) / 4);
const pressKg = (n: number) => 45 + 1.25 * Math.floor((n - 1) / 2);
const longMetres = (n: number) => 9000 + 1000 * n;

// ---- local times ------------------------------------------------------------------------------

/** The instant's wall-clock time in `timeZone`, read as if it were UTC (ms). */
const wallMs = (instant: number, timeZone: string) =>
	Date.parse(`${new Date(instant).toLocaleString('sv-SE', { timeZone }).replace(' ', 'T')}Z`);

/** The instant it is `time` (HH:MM) on `date` in `timeZone`; fixtures avoid the 1–3 am DST hours. */
export function atLocal(date: IsoDate, time: string, timeZone: string): Date {
	const guess = Date.parse(`${date}T${time}:00Z`);
	let instant = guess - (wallMs(guess, timeZone) - guess);
	instant = guess - (wallMs(instant, timeZone) - instant);
	return new Date(instant);
}

const minutes = (instant: Date, n: number) => new Date(instant.getTime() + n * 60_000);

// ---- the plan ---------------------------------------------------------------------------------

/** Each space-separated field set to null: the plan fields these fixtures leave empty. */
const nulls = (fields: string) => Object.fromEntries(fields.split(' ').map((f) => [f, null]));

const rx = (role: SetPrescription['role'], sets: number, reps: number, rpe: number) =>
	({
		...nulls(
			'seconds metres loadValue loadUnit loadBasis reference1rm reference1rmUnit tempo notes'
		),
		...{ role, sets, repsMin: reps, repsMax: reps, targetRpe: rpe, loadKind: 'rpe_based' },
		restSeconds: 120
	}) as SetPrescription;

const lift = (key: Key, sets: SetPrescription[]) =>
	({
		...nulls('baselineLift superset substitutedFrom substitutionReason instructions notes'),
		...{ exercise: { key }, sets }
	}) as PlannedExercisePlan;

const segment = (kind: RunSegment['kind'], over: Partial<RunSegment>) =>
	({
		...nulls('repeatGroup repeats distanceMetres durationSeconds hrZone targetRpe'),
		...nulls('paceMinSecondsPerKm paceMaxSecondsPerKm'),
		...{ kind, ...over }
	}) as RunSegment;

const base = (date: IsoDate, title: string, estMinutes: number, rpe: number) => ({
	...{ date, title, timeOfDay: 'morning' as const, orderInDay: 1, estMinutes, targetRpe: rpe },
	...{ customDiscipline: null, commitmentRef: null, instructions: null, notes: null },
	estLoad: estMinutes * rpe,
	intensity: rpe >= 8 ? ('hard' as const) : ('moderate' as const),
	source: 'generator' as const
});

const strengthPlan = (date: IsoDate, title: string, exercises: PlannedExercisePlan[]) => ({
	...base(date, title, 60, 8),
	kind: 'strength' as const,
	type: 'strength' as const,
	discipline: 'strength' as const,
	exercises
});

const runPlan = (date: IsoDate, type: SessionType, title: string, segments: RunSegment[]) => ({
	...base(date, title, 45, type === 'long_run' ? 6 : 7),
	kind: 'run' as const,
	type,
	discipline: 'running' as const,
	segments
});

/** Week n's sessions, Monday `monday`. */
function plannedWeek(monday: IsoDate, n: number, commitment: string): SessionPlan[] {
	const day = (d: number) => addDays(monday, d);
	const reps = { repeatGroup: 1, repeats: 4 };
	return [
		strengthPlan(day(0), 'Strength A', [
			lift('back_squat', [rx('warm_up', 1, 5, 5), rx('working', 3, 5, 8)]),
			lift('bench_press', [rx('working', 3, 5, 8)]),
			lift('barbell_row', [rx('working', 3, 8, 7)])
		]),
		runPlan(day(1), 'interval_run', 'Intervals', [
			segment('warm_up', { distanceMetres: 2000 }),
			segment('interval', { ...reps, distanceMetres: 800 }),
			segment('recovery', { ...reps, durationSeconds: 90 }),
			segment('cool_down', { distanceMetres: 1500 })
		]),
		{
			...base(day(1), 'Muay Thai class', 90, 7),
			timeOfDay: 'evening',
			orderInDay: 2,
			source: 'commitment',
			commitmentRef: commitment,
			kind: 'other',
			type: 'muay_thai',
			discipline: 'muay_thai',
			details: { kind: 'class', durationMinutes: 90, targetRpe: 7, metrics: [], notes: null }
		},
		strengthPlan(day(2), 'Strength B', [
			lift('deadlift', [rx('warm_up', 1, 5, 5), rx('working', 2, 5, 8)]),
			lift('overhead_press', [rx('working', 3, 5, 8)]),
			lift('dumbbell_curl', [rx('working', 3, 10, 8)])
		]),
		runPlan(day(3), 'tempo_run', 'Tempo run', [
			segment('warm_up', { distanceMetres: 1500 }),
			segment('tempo', { distanceMetres: 5000 }),
			segment('cool_down', { distanceMetres: 1000 })
		]),
		runPlan(day(5), 'long_run', 'Long run', [segment('long', { distanceMetres: longMetres(n) })])
	];
}

const deload = (n: number) => n % 4 === 0 && n <= 8;

function week(monday: IsoDate, n: number, commitment: string): WeekPlan {
	const easy = deload(n);
	return {
		kind: easy ? 'deload' : 'accumulation',
		startsOn: monday,
		endsOn: addDays(monday, 6),
		targets: easy
			? { rpeCap: 7, volumeFactor: 0.6, loadStep: -0.1, runVolumeFactor: 0.7 }
			: { rpeCap: 8, volumeFactor: 1, loadStep: 0.025, runVolumeFactor: 1 },
		sessions: plannedWeek(monday, n, commitment)
	};
}

/** Blocks of 4, 4 and the rest of the weeks (one block for a short program). */
function programPlan(start: IsoDate, weeks: number, commitment: string, goal: string): ProgramPlan {
	const all = Array.from({ length: weeks }, (_, i) =>
		week(addDays(start, 7 * i), i + 1, commitment)
	);
	const cuts = weeks > 8 ? [0, 4, 8, weeks] : [0, weeks];
	const names = ['Base', 'Build', 'Push'] as const;
	const blocks: BlockPlan[] = cuts.slice(1).map((end, b) => {
		const own = all.slice(cuts[b], end);
		return {
			phase: b === 1 ? 'intensification' : 'accumulation',
			name: names[b]!,
			startsOn: own[0]!.startsOn,
			endsOn: own.at(-1)!.endsOn,
			outline: false,
			goalRefs: [goal],
			progression: { rpeStepPerWeek: 0.5, rpeCap: 8.5 },
			weeks: own
		};
	});
	const decision = {
		kind: 'program_purpose' as const,
		ruleKey: 'blocks.default',
		summary: 'Strength, running and Muay Thai together',
		why: 'Fixture program: two lifting days, three runs and the weekly class.',
		decidedBy: 'rules' as const,
		refs: ['blocks.0'],
		evidence: {}
	};
	const title = 'Strength, running and Muay Thai';
	return { title, startsOn: start, firstPlannedDay: start, blocks, decisions: [decision] };
}

// ---- the profile ------------------------------------------------------------------------------

/** The hybrid athlete's profile; returns the goal and the Muay Thai commitment's ids. */
async function hybridProfile(ctx: SeedContext, raceOn: IsoDate) {
	const deps = { db: ctx.db };
	const goal = await createGoal(
		ctx.ownerId,
		{
			kind: 'general',
			title: 'Stronger, fitter, sharper',
			disciplines: ['strength', 'running', 'muay_thai'],
			focus: 'Squat and deadlift up while the long run grows',
			measure: 'Top sets and long-run distance, week on week'
		},
		deps
	);
	await saveBaselines(
		ctx.ownerId,
		{
			unknown: false,
			lifts: [
				{ lift: 'back_squat', source: 'estimate', value: 140, unit: 'kg' },
				{ lift: 'bench_press', source: 'tested', value: 100, unit: 'kg', achievedOn: raceOn },
				{ lift: 'deadlift', source: 'estimate', value: 170, unit: 'kg' }
			]
		},
		deps
	);
	const race = { distance: '10k', timeSeconds: 2880, racedOn: raceOn, eventName: 'Riverside 10K' };
	await saveSpecifics(
		ctx.ownerId,
		{
			running: {
				unit: 'km',
				weeklyDistance: 25,
				runsPerWeek: 3,
				longestRun: 12,
				easyPaceSeconds: 330,
				races: [race]
			},
			muayThai: { sessionsPerWeek: 1, sparringPerWeek: 0, fights: 0 }
		},
		deps
	);
	const schedule = await saveSchedule(
		ctx.ownerId,
		{
			daysPerWeek: 6,
			availableDays: ['mon', 'tue', 'wed', 'thu', 'sat', 'sun'],
			preferredTimes: ['morning', 'evening'],
			sessionMinutes: 60,
			commitments: [
				{
					discipline: 'muay_thai',
					label: 'Muay Thai class',
					days: ['tue'],
					timeOfDay: 'evening',
					durationMinutes: 90,
					intensity: 'hard',
					notes: null
				}
			]
		},
		deps
	);
	return { goal: goal.id, commitment: schedule.commitments[0]!.id };
}

/** Store the plan with the profile's generator input as its origin snapshot. */
async function storeProgram(ctx: SeedContext, plan: ProgramPlan) {
	const deps = { db: ctx.db };
	const input = buildProgrammingInput(await getTrainingProfile(ctx.ownerId, deps), {
		catalogue: CATALOGUE
	});
	const origin = {
		source: 'rules' as const,
		generator: GENERATOR_ID,
		digest: catalogueDigest(CATALOGUE, []),
		snapshot: input as unknown as Record<string, unknown>
	};
	return (await createProgramFromPlan(ctx.ownerId, plan, origin, deps)).programId;
}

// ---- logging ----------------------------------------------------------------------------------

interface SetSpec {
	key: Key;
	weight: number;
	reps: number;
	rpe: number | null;
	warmup?: boolean;
}

const sets = (count: number, spec: SetSpec): SetSpec[] => Array.from({ length: count }, () => spec);

interface Logger {
	ctx: SeedContext;
	ids: Readonly<Record<Key, string>>;
}

const deps = (log: Logger) => ({ db: log.ctx.db });

const DISCIPLINE = { strength: 'strength', run: 'running', other: 'muay_thai' } as const;

/** Start a workout of `kind` at `at`, from `planned` or off plan. */
async function start(
	log: Logger,
	kind: keyof typeof DISCIPLINE,
	[sessionType, title]: [SessionType, string],
	planned: StoredSession | null,
	at: Date
) {
	const clientId = crypto.randomUUID();
	const input = { clientId, kind, discipline: DISCIPLINE[kind], sessionType, title };
	const startedAt = at.toISOString();
	const plannedSessionId = planned?.id ?? null;
	const { workout } = await startWorkout(
		log.ctx.ownerId,
		{ ...input, plannedSessionId, startedAt },
		deps(log)
	);
	return { clientId, id: workout.id };
}

/** How a workout ends: `minutes` after it started, completed unless `status` says otherwise. */
type Done = { minutes: number; durationSeconds: number; sessionRpe?: number; status?: string };

async function finish(log: Logger, clientId: string, at: Date, { minutes: m, ...done }: Done) {
	const input = { status: 'completed', finishedAt: minutes(at, m).toISOString(), ...done };
	await finishWorkout(log.ctx.ownerId, clientId, input, deps(log));
}

/** Log `specs` in order, five minutes apart; positions follow each exercise's first set. */
async function logSets(
	log: Logger,
	clientId: string,
	from: Date,
	specs: SetSpec[],
	plan?: StoredSession
) {
	const exercises = plan?.kind === 'strength' ? plan.exercises : [];
	const lineageOf = (key: Key) =>
		exercises.find((e) => 'key' in e.exercise && e.exercise.key === key)?.lineage ?? null;
	const order: Key[] = [];
	for (const [i, spec] of specs.entries()) {
		if (!order.includes(spec.key)) order.push(spec.key);
		const input = {
			clientMutationId: crypto.randomUUID(),
			workoutClientId: clientId,
			exerciseId: log.ids[spec.key],
			plannedExerciseLineageId: lineageOf(spec.key),
			exercisePosition: order.indexOf(spec.key) + 1,
			setIndex: specs.slice(0, i + 1).filter((o) => o.key === spec.key).length,
			...{ weight: spec.weight, unit: 'kg', reps: spec.reps, missedReps: 0, rpe: spec.rpe },
			...{ seconds: null, metres: null, isExtra: false, isSkipped: false },
			isWarmup: spec.warmup ?? false,
			performedAt: minutes(from, 5 * (i + 1)).toISOString()
		};
		await logSet(log.ctx.ownerId, input, deps(log));
	}
}

/** A strength workout: started, its sets logged, then finished as `done` says. */
async function lifting(
	log: Logger,
	what: [SessionType, string],
	planned: StoredSession | null,
	at: Date,
	specs: SetSpec[],
	done: Done | null
) {
	const w = await start(log, 'strength', what, planned, at);
	await logSets(log, w.clientId, at, specs, planned ?? undefined);
	if (done) await finish(log, w.clientId, at, done);
	return w;
}

const strengthSets = (session: 'A' | 'B', n: number): SetSpec[] =>
	session === 'A'
		? [
				{ key: 'back_squat', weight: 60, reps: 5, rpe: null, warmup: true },
				...sets(3, { key: 'back_squat', weight: squatKg(n), reps: 5, rpe: 8 }),
				...sets(3, { key: 'bench_press', weight: BENCH[n - 1]!, reps: 5, rpe: BENCH_RPE[n - 1]! }),
				...sets(3, { key: 'barbell_row', weight: rowKg(n), reps: 8, rpe: 7 })
			]
		: [
				{ key: 'deadlift', weight: 80, reps: 5, rpe: null, warmup: true },
				...sets(2, { key: 'deadlift', weight: deadliftKg(n), reps: 5, rpe: n === 7 ? 9 : 8 }),
				...sets(3, { key: 'overhead_press', weight: pressKg(n), reps: 5, rpe: 8 }),
				...sets(3, { key: 'dumbbell_curl', weight: 14, reps: 10, rpe: 8 })
			];

type Kind = RunSegment['kind'];
type RunPiece = { kind: Kind; metres: number; seconds: number };

/** Week n's run of `type`, as run: its pieces. */
function runPieces(type: SessionType, n: number): RunPiece[] {
	const piece = (kind: Kind, metres: number, seconds: number) => ({ kind, metres, seconds });
	if (type === 'interval_run') {
		const [rep, rest] = [piece('interval', 800, 200 - n), piece('recovery', 200, 90)];
		const reps = [rep, rest, rep, rest, rep, rest, rep];
		return [piece('warm_up', 2000, 720), ...reps, piece('cool_down', 1500, 540)];
	}
	if (type === 'tempo_run') {
		const tempo = piece('tempo', 5000, 1500 - 5 * n);
		return [piece('warm_up', 1500, 540), tempo, piece('cool_down', 1000, 360)];
	}
	if (type === 'long_run') return [piece('long', longMetres(n), Math.round(longMetres(n) * 0.33))];
	return [piece('easy', 5000, 1800)];
}

const RUN_RPE: Partial<Record<SessionType, number>> = {
	interval_run: 8,
	tempo_run: 7,
	long_run: 6
};

function runHr(type: SessionType, n: number): number | null {
	if (type === 'long_run') return n >= 5 ? 146 : null;
	if (type === 'interval_run') return n >= 9 ? 162 : null;
	return type === 'tempo_run' && n >= 9 ? 168 : null;
}

async function logRunWorkout(
	log: Logger,
	type: SessionType,
	title: string,
	n: number,
	at: Date,
	planned: StoredSession | null
) {
	const w = await start(log, 'run', [type, title], planned, at);
	const pieces = runPieces(type, n);
	const metres = pieces.reduce((sum, p) => sum + p.metres, 0);
	const seconds = pieces.reduce((sum, p) => sum + p.seconds, 0);
	const rpe = RUN_RPE[type] ?? 4;
	const measured = (m: number, s: number) => ({
		distance: { value: m, unit: 'm' },
		durationSeconds: s
	});
	const segments = pieces.map((p, i) => ({
		...{ clientMutationId: crypto.randomUUID(), position: i + 1, kind: p.kind },
		...{ ...measured(p.metres, p.seconds), avgHr: null, rpe: null }
	}));
	const run = { ...measured(metres, seconds), avgHr: runHr(type, n), rpe, notes: null };
	await logRun(log.ctx.ownerId, { workoutClientId: w.clientId, ...run, segments }, deps(log));
	const done = { minutes: Math.ceil(seconds / 60) + 5, durationSeconds: seconds, sessionRpe: rpe };
	await finish(log, w.clientId, at, done);
	return w;
}

/** Log planned session `s` of week n as the fixture does, on its (possibly moved) date. */
async function logPlanned(log: Logger, s: StoredSession, n: number) {
	const tz = log.ctx.timeZone;
	if (s.kind === 'run') {
		const at = atLocal(s.date, s.type === 'long_run' ? '08:00' : '06:30', tz);
		return logRunWorkout(log, s.type, s.title, n, at, s);
	}
	if (s.kind === 'other') {
		const at = atLocal(s.date, '19:00', tz);
		const w = await start(log, 'other', ['muay_thai', s.title], s, at);
		const metrics = [
			{ key: 'rounds', label: 'Rounds', unit: null, value: 6 + (n % 3) },
			...(n % 2 === 0
				? [{ key: 'sparring_rounds', label: 'Sparring rounds', unit: null, value: 2 }]
				: [])
		];
		const session = { kind: 'class', durationMinutes: 90, rpe: 7, metrics, notes: null };
		await logOtherSession(log.ctx.ownerId, { workoutClientId: w.clientId, ...session }, deps(log));
		await finish(log, w.clientId, at, { minutes: 95, durationSeconds: 5400, sessionRpe: 7 });
		return w;
	}
	const which = s.title === 'Strength A' ? 'A' : 'B';
	const done = { minutes: 65, durationSeconds: 3600, sessionRpe: which === 'A' ? 7.5 : 8 };
	const at = atLocal(s.date, '07:00', tz);
	return lifting(log, ['strength', s.title], s, at, strengthSets(which, n), done);
}

const sessionsOf = (version: Awaited<ReturnType<typeof getProgramVersion>>) =>
	version.blocks.flatMap((b) => b.weeks.flatMap((w) => w.sessions));

async function exerciseIds(ctx: SeedContext): Promise<Record<Key, string>> {
	const found = await resolveKeys(KEYS, { db: ctx.db });
	return Object.fromEntries(KEYS.map((key) => [key, found.get(key)!.id])) as Record<Key, string>;
}

// ---- the fixtures -----------------------------------------------------------------------------

const none = { workouts: {}, lineages: {} };
const newUser: AnalyticsFixture = async () => ({
	programId: null,
	historyStart: null,
	exercises: {},
	...none
});

/** This week's program, logged as planned up to yesterday. */
const firstWeek: AnalyticsFixture = async (ctx) => {
	const { goal, commitment } = await hybridProfile(ctx, addDays(ctx.weekStart, -30));
	const programId = await storeProgram(ctx, programPlan(ctx.weekStart, 2, commitment, goal));
	const log = { ctx, ids: await exerciseIds(ctx) };
	const stored = await getProgramVersion(ctx.ownerId, programId, 1, { db: ctx.db });
	for (const s of sessionsOf(stored).filter((s) => s.date < ctx.today)) await logPlanned(log, s, 1);
	return { programId, historyStart: ctx.weekStart, exercises: log.ids, ...none };
};

const twelveWeeks: AnalyticsFixture = async (ctx) => {
	const { ownerId, db, timeZone: tz } = ctx;
	const deps = { db };
	const startOn = addDays(ctx.weekStart, -7 * HISTORY_WEEKS);
	const weekOf = (n: number) => addDays(startOn, 7 * (n - 1));
	const { goal, commitment } = await hybridProfile(ctx, addDays(weekOf(8), 6));
	const programId = await storeProgram(ctx, programPlan(startOn, PROGRAM_WEEKS, commitment, goal));
	const log = { ctx, ids: await exerciseIds(ctx) };

	// The edits, each on the day it was made: they must come before the logging they shape.
	const v1 = sessionsOf(await getProgramVersion(ownerId, programId, 1, deps));
	const at = (date: IsoDate, type: SessionType) =>
		v1.find((s) => s.date === date && s.type === type)!;
	const skipped = at(addDays(weekOf(6), 3), 'tempo_run');
	const moved = at(addDays(weekOf(7), 5), 'long_run');
	const missed = at(addDays(weekOf(10), 2), 'strength');
	const reason = 'Fixture edit';
	const skip = { sessionLineage: skipped.lineage, reason };
	const v2 = await skipSession(ownerId, skip, { version: 1, today: skipped.date }, deps);
	const move = { sessionLineage: moved.lineage, toDate: addDays(moved.date, 1), reason };
	const at3 = { version: v2.number, today: moved.date };
	const { number } = await moveSession(ownerId, move, at3, deps);
	const current = sessionsOf(await getProgramVersion(ownerId, programId, number, deps));

	const special = new Set([skipped.lineage, missed.lineage]);
	for (let n = 1; n <= HISTORY_WEEKS + 1; n++) {
		const own = current.filter((s) => s.date >= weekOf(n) && s.date < weekOf(n + 1));
		for (const s of own.filter((s) => s.date < ctx.today && !special.has(s.lineage))) {
			await logPlanned(log, s, n);
		}
		if (n <= HISTORY_WEEKS) {
			await recordRecoveryNote(
				ownerId,
				{
					clientMutationId: crypto.randomUUID(),
					notedOn: weekOf(n),
					sleepHours: 7 + 0.5 * (n % 3),
					soreness: 2 + (n % 2),
					energy: 4 - (n % 2),
					stress: 2,
					note: n === HISTORY_WEEKS ? 'Legs heavy after the long run' : null
				},
				deps
			);
		}
	}

	const offPlanAt = atLocal(addDays(weekOf(9), 4), '07:00', tz);
	const offPlan = await logRunWorkout(log, 'recovery_run', 'Recovery run', 9, offPlanAt, null);

	// The discarded three, each with live sets: abandoned (so week 10's Strength B is missed),
	// completed and then soft-deleted, and in progress since 20 minutes ago.
	const missedRow = current.find((s) => s.lineage === missed.lineage)!;
	const abandoned = await lifting(
		log,
		['strength', missedRow.title],
		missedRow,
		atLocal(missedRow.date, '07:00', tz),
		sets(2, { key: 'deadlift', weight: 230, reps: 3, rpe: 9 }),
		{ minutes: 20, status: 'abandoned', durationSeconds: 1200 }
	);
	const armsAt = atLocal(addDays(weekOf(11), 4), '18:00', tz);
	const curls = sets(3, { key: 'dumbbell_curl', weight: 24, reps: 10, rpe: 8 });
	const done = { minutes: 30, durationSeconds: 1800, sessionRpe: 8 };
	const deleted = await lifting(log, ['hypertrophy', 'Arms'], null, armsAt, curls, done);
	// No service deletes a workout yet (M4's sync will): the soft delete its guards allow, alone.
	const deletedAt = minutes(armsAt, 60);
	await db.update(workouts).set({ deletedAt }).where(eq(workouts.id, deleted.id));
	const squats = sets(2, { key: 'back_squat', weight: 150, reps: 5, rpe: 9 });
	const liveAt = minutes(ctx.now, -20);
	const inProgress = await lifting(log, ['strength', 'Full body'], null, liveAt, squats, null);

	return {
		programId,
		historyStart: startOn,
		exercises: log.ids,
		workouts: Object.fromEntries(
			Object.entries({ abandoned, deleted, inProgress, offPlan }).map(([k, w]) => [k, w.id])
		),
		lineages: { skipped: skipped.lineage, moved: moved.lineage, missed: missed.lineage }
	} satisfies FixtureResult;
};

export const fixtures = {
	'new-user': newUser,
	'first-week': firstWeek,
	'twelve-weeks': twelveWeeks
} satisfies Record<string, AnalyticsFixture>;
