/**
 * The M6 dataset: 16 deterministic weeks for one Los Angeles owner, from Monday WEEK_ONE, which
 * every M6 service test reads. Never edited once merged: a test that needs more seeds it itself.
 *
 * Programs, through the real services, each stored with its profile's generator input as its
 * origin snapshot (so its blocks have a stored input):
 * - A (weeks 1–6), built on a hypertrophy goal during a cut: blocks A1 (weeks 1–3) and A2
 *   (weeks 4–6). Version 2 adjusts week 3's Strength A bench to 4 sets on that Monday, after its
 *   workout started under version 1. Archived at the end of week 6.
 * - B (weeks 7–16), the same goal with no nutrition phase: B1 (weeks 7–11, week 11 a 0.6
 *   deload), B2 (weeks 12–16) and an outline B3 (weeks 17–20). Version 2 skips week 9's tempo run.
 * Each week plans Strength A (Mon), intervals and a Muay Thai class (Tue), Strength B (Wed), a
 * tempo run (Thu) and a long run (Sat). Everything planned is logged as planned, on the version
 * current that day, except the skipped tempo run, the missed long run of week 10 and week 12's
 * Strength B, which is abandoned. The numbers, for week n:
 * - squat 3 × 5 at 100 + 2.5(n − 1) kg, RPE 8, after a 60 kg warm-up: rising
 * - bench 3 × 5 at BENCH[n − 1], RPE BENCH_RPE[n − 1]: flat and noisy; a tested 1RM of 100 kg
 * - row 3 × 8 at 60 kg, RPE 7; deadlift 2 × 5 at 140 + 2.5(n − 1) kg, RPE 8, but 190 kg at RPE 9
 *   in week 8 (the outlier); curl 3 × 10 at 14 kg, RPE 8 every week (the stalled accessory)
 * - intervals in km: 2 km warm-up, four 800 m reps in 200 − n s with 90 s recoveries, 1.5 km
 *   cool-down; tempo in miles: 1 mi, 3 mi in 1500 − 5n s, 1 mi; long run 9 + 0.5n km at 330 s/km
 * - Muay Thai 90 min, 6 + (n mod 3) rounds, 2 sparring rounds in even weeks
 * - a recovery note every Monday; a 10 km race result in week 8
 * Sets: an extra bench set (week 2), a skipped curl set (week 3), a deleted squat set (week 5),
 * an edited bench set (week 6). Off plan: a Sunday 23:00 arms session in week 4 (its last set at
 * 23:30), an 'Arms' workout in week 13 completed then soft-deleted, a run abandoned in week 14
 * with its segments, and a workout still in progress on week 16's Sunday; each discarded one
 * has live sets heavy enough to top any figure if it were ever counted. A second owner logs a
 * workout, a run and a note in week 5.
 */
import { eq, sql } from 'drizzle-orm';
import { addDays, type IsoDate } from '../../../../src/lib/domain/calendar';
import { CATALOGUE } from '../../../../src/lib/domain/exercises/index';
import {
	buildProgrammingInput,
	catalogueDigest,
	GENERATOR_ID
} from '../../../../src/lib/domain/programming';
import { setE1rm } from '../../../../src/lib/domain/training/metrics';
import type {
	BlockPlan,
	PlannedExercisePlan,
	ProgramPlan,
	RunSegment,
	SessionPlan,
	SetPrescription,
	WeekPlan
} from '../../../../src/lib/domain/training/types';
import type { SessionType } from '../../../../src/lib/domain/training/vocabulary';
import { toMetres } from '../../../../src/lib/domain/units';
import {
	otherSessionRecords,
	programs,
	recoveryNotes,
	runRecords,
	runRecordSegments,
	setRecords,
	workouts,
	type Executor,
	type WorkoutKind,
	type WorkoutStatus
} from '../../../../src/lib/server/db';
import { resolveKeys } from '../../../../src/lib/server/services/exercises/index';
import {
	createGoal,
	getTrainingProfile,
	saveBaselines,
	saveBasics,
	saveBody,
	saveSchedule,
	saveSpecifics
} from '../../../../src/lib/server/services/profile/index';
import {
	adjustPrescription,
	createProgramFromPlan,
	getProgramVersion,
	skipSession,
	type StoredSession
} from '../../../../src/lib/server/services/programs/index';
import { atLocal } from '../../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { makeOwner } from '../../profile/fixtures';

export const TZ = 'America/Los_Angeles';
/** Monday of week 1. */
export const WEEK_ONE: IsoDate = '2026-01-05';
export const WEEKS = 16;
export const weekOf = (n: number): IsoDate => addDays(WEEK_ONE, 7 * (n - 1));
/** The Sunday of week 16, and the Wednesday after it. */
export const LAST_DAY: IsoDate = addDays(weekOf(WEEKS), 6);
export const TODAY: IsoDate = addDays(weekOf(WEEKS + 1), 2);

export const KEYS = [
	'back_squat',
	'bench_press',
	'barbell_row',
	'deadlift',
	'dumbbell_curl'
] as const;
export type Key = (typeof KEYS)[number];

export const BENCH = [80, 82.5, 77.5, 80, 85, 77.5, 80, 82.5, 75, 80, 82.5, 80, 77.5, 85, 80, 82.5];
export const BENCH_RPE = [8, 8.5, 7.5, 8, 9, 7.5, 8, 8.5, 6.5, 8, 8.5, 8, 7.5, 9, 8, 8.5];
export const squatKg = (n: number) => 100 + 2.5 * (n - 1);
export const deadliftKg = (n: number) => (n === 8 ? 190 : 140 + 2.5 * (n - 1));
export const longMetres = (n: number) => 9000 + 500 * n;
const DELOAD_WEEK = 11;

export interface Dataset {
	owner: string;
	/** The second owner. */
	other: string;
	programs: { a: string; b: string };
	exercises: Record<Key, string>;
	/** Workout row ids. */
	workouts: {
		abandoned: string;
		inProgress: string;
		deleted: string;
		abandonedRun: string;
		sundayNight: string;
		/** Week 3's Strength A, logged under version 1 of A. */
		underV1: string;
		other: string[];
	};
	/** Set row ids. */
	sets: { sundayNight: string; deleted: string; skipped: string; extra: string; edited: string };
	/** Planned-session lineages, and version 1's row of the session logged under it. */
	sessions: {
		underV1Row: string;
		underV1: string;
		skipped: string;
		missed: string;
		abandoned: string;
	};
	/** Planned-exercise lineage of the bench that A's version 2 adjusted. */
	adjustedBench: string;
}

// ---- the plan ---------------------------------------------------------------------------------

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
	...{ kind: 'strength' as const, type: 'strength' as const, discipline: 'strength' as const },
	exercises
});

const runPlan = (date: IsoDate, type: SessionType, title: string, segments: RunSegment[]) => ({
	...base(date, title, 45, type === 'long_run' ? 6 : 7),
	...{ kind: 'run' as const, type, discipline: 'running' as const },
	segments
});

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
			...{ timeOfDay: 'evening', orderInDay: 2, source: 'commitment', commitmentRef: commitment },
			...{ kind: 'other', type: 'muay_thai', discipline: 'muay_thai' },
			details: { kind: 'class', durationMinutes: 90, targetRpe: 7, metrics: [], notes: null }
		},
		strengthPlan(day(2), 'Strength B', [
			lift('deadlift', [rx('warm_up', 1, 5, 5), rx('working', 2, 5, 8)]),
			lift('dumbbell_curl', [rx('working', 3, 10, 8)])
		]),
		runPlan(day(3), 'tempo_run', 'Tempo run', [
			segment('warm_up', { distanceMetres: Math.round(toMetres(1, 'mi')) }),
			segment('tempo', { distanceMetres: Math.round(toMetres(3, 'mi')) }),
			segment('cool_down', { distanceMetres: Math.round(toMetres(1, 'mi')) })
		]),
		runPlan(day(5), 'long_run', 'Long run', [segment('long', { distanceMetres: longMetres(n) })])
	];
}

function week(n: number, commitment: string, outline = false): WeekPlan {
	const deload = n === DELOAD_WEEK;
	return {
		kind: deload ? 'deload' : 'accumulation',
		startsOn: weekOf(n),
		endsOn: addDays(weekOf(n), 6),
		targets: deload
			? { rpeCap: 7, volumeFactor: 0.6, loadStep: -0.1, runVolumeFactor: 0.7 }
			: { rpeCap: 8, volumeFactor: 1, loadStep: 0.025, runVolumeFactor: 1 },
		sessions: outline ? [] : plannedWeek(weekOf(n), n, commitment)
	};
}

/** A program of blocks [name, first week, last week, outline?], from week `first`. */
function programPlan(
	title: string,
	blocks: [string, number, number, boolean?][],
	commitment: string,
	goal: string
): ProgramPlan {
	const planned: BlockPlan[] = blocks.map(([name, first, last, outline = false], b) => {
		const weeks = Array.from({ length: last - first + 1 }, (_, i) =>
			week(first + i, commitment, outline)
		);
		return {
			...{ phase: b === 1 ? 'intensification' : 'accumulation', name, outline },
			...{ startsOn: weeks[0]!.startsOn, endsOn: weeks.at(-1)!.endsOn, goalRefs: [goal] },
			progression: outline ? {} : { rpeStepPerWeek: 0.5, rpeCap: 8.5 },
			weeks
		} as BlockPlan;
	});
	const decision = {
		...{ kind: 'program_purpose' as const, ruleKey: 'blocks.default', decidedBy: 'rules' as const },
		...{ summary: 'Muscle first, with running and Muay Thai', refs: ['blocks.0'], evidence: {} },
		why: 'Dataset program: two lifting days, three runs and the weekly class.'
	};
	const startsOn = planned[0]!.startsOn;
	return { title, startsOn, firstPlannedDay: startsOn, blocks: planned, decisions: [decision] };
}

// ---- writing the log --------------------------------------------------------------------------

const MINUTE = 60_000;
const later = (at: Date, minutes: number) => new Date(at.getTime() + minutes * MINUTE);

interface WorkoutSpec {
	kind: WorkoutKind;
	at: Date;
	title: string;
	sessionType: SessionType;
	minutes: number;
	status?: WorkoutStatus;
	deleted?: boolean;
	planned?: StoredSession;
	programId?: string;
	sessionRpe?: number;
}

const DISCIPLINE = { strength: 'strength', run: 'running', other: 'muay_thai' } as const;

async function insertWorkout(db: Executor, owner: string, w: WorkoutSpec): Promise<string> {
	const status = w.status ?? 'completed';
	const done = status !== 'in_progress';
	const [row] = await db
		.insert(workouts)
		.values({
			ownerId: owner,
			clientId: crypto.randomUUID(),
			...{ kind: w.kind, discipline: DISCIPLINE[w.kind], sessionType: w.sessionType },
			title: w.title,
			plannedSessionId: w.planned?.id ?? null,
			plannedLineageId: w.planned?.lineage ?? null,
			programId: w.planned ? w.programId! : null,
			status,
			startedAt: w.at,
			finishedAt: done ? later(w.at, w.minutes) : null,
			durationSeconds: done ? w.minutes * 60 : null,
			sessionRpe: done ? (w.sessionRpe ?? 7.5) : null,
			deletedAt: w.deleted ? later(w.at, w.minutes + 60) : null
		})
		.returning({ id: workouts.id });
	return row!.id;
}

interface SetSpec {
	key: Key;
	weight: number;
	reps: number;
	rpe: number | null;
	warmup?: boolean;
	extra?: boolean;
	skipped?: boolean;
	deleted?: boolean;
	/** Minutes after the workout started; five per set unless given. */
	minute?: number;
}

const sets = (count: number, spec: SetSpec): SetSpec[] => Array.from({ length: count }, () => spec);

/** A strength workout and its sets in order; returns its id and its set ids. */
async function lifting(
	db: Executor,
	owner: string,
	ids: Record<Key, string>,
	w: Omit<WorkoutSpec, 'kind'>,
	specs: SetSpec[]
) {
	const id = await insertWorkout(db, owner, { ...w, kind: 'strength' });
	const lineageOf = (key: Key) =>
		w.planned?.kind === 'strength'
			? (w.planned.exercises.find((e) => 'key' in e.exercise && e.exercise.key === key)?.lineage ??
				null)
			: null;
	const order: Key[] = [];
	const setIds: string[] = [];
	for (const [i, spec] of specs.entries()) {
		if (!order.includes(spec.key)) order.push(spec.key);
		const set = {
			...{ weight: spec.weight, unit: 'kg' as const, reps: spec.reps, rpe: spec.rpe },
			isWarmup: spec.warmup ?? false,
			isSkipped: spec.skipped ?? false
		};
		const performedAt = later(w.at, spec.minute ?? 5 * (i + 1));
		const [row] = await db
			.insert(setRecords)
			.values({
				ownerId: owner,
				clientMutationId: crypto.randomUUID(),
				workoutId: id,
				exerciseId: ids[spec.key],
				plannedExerciseLineageId: lineageOf(spec.key),
				exercisePosition: order.indexOf(spec.key) + 1,
				setIndex: specs.slice(0, i + 1).filter((o) => o.key === spec.key).length,
				...set,
				isExtra: spec.extra ?? false,
				e1rmKg: setE1rm(set)?.value ?? null,
				performedAt,
				deletedAt: spec.deleted ? later(w.at, 120) : null
			})
			.returning({ id: setRecords.id });
		setIds.push(String(row!.id));
	}
	return { id, setIds };
}

type Piece = [kind: RunSegment['kind'], metres: number, seconds: number];

function runPieces(type: SessionType, n: number): Piece[] {
	if (type === 'interval_run') {
		const rep: Piece = ['interval', 800, 200 - n];
		const rest: Piece = ['recovery', 250, 90];
		return [['warm_up', 2000, 720], rep, rest, rep, rest, rep, rest, rep, ['cool_down', 1500, 540]];
	}
	if (type === 'tempo_run') {
		const mile = toMetres(1, 'mi');
		return [
			['warm_up', mile, 540],
			['tempo', 3 * mile, 1500 - 5 * n],
			['cool_down', mile, 540]
		];
	}
	if (type === 'long_run') return [['long', longMetres(n), Math.round(longMetres(n) * 0.33)]];
	return [['easy', 5000, 1800]];
}

async function running(
	db: Executor,
	owner: string,
	w: Omit<WorkoutSpec, 'kind' | 'minutes' | 'sessionType'> & { type: SessionType; n: number }
) {
	const pieces = runPieces(w.type, w.n);
	const metres = pieces.reduce((sum, [, m]) => sum + m, 0);
	const seconds = pieces.reduce((sum, [, , s]) => sum + s, 0);
	const minutes = Math.ceil(seconds / 60);
	const id = await insertWorkout(db, owner, { ...w, kind: 'run', sessionType: w.type, minutes });
	const avgHr = w.type === 'long_run' ? 145 : 160;
	const rpe = w.type === 'long_run' ? 6 : 7.5;
	await db.insert(runRecords).values({
		ownerId: owner,
		workoutId: id,
		distanceMetres: metres,
		durationSeconds: seconds,
		avgHr,
		rpe
	});
	for (const [i, [kind, distanceMetres, durationSeconds]] of pieces.entries()) {
		await db.insert(runRecordSegments).values({
			...{ ownerId: owner, clientMutationId: crypto.randomUUID(), workoutId: id },
			...{ position: i + 1, kind, distanceMetres, durationSeconds }
		});
	}
	return id;
}

async function muayThai(
	db: Executor,
	owner: string,
	w: Omit<WorkoutSpec, 'kind' | 'minutes' | 'sessionType'>,
	n: number
) {
	const id = await insertWorkout(db, owner, {
		...w,
		kind: 'other',
		sessionType: 'muay_thai',
		minutes: 90
	});
	const metrics = [
		{ key: 'rounds', label: 'Rounds', unit: null, value: 6 + (n % 3) },
		...(n % 2 === 0
			? [{ key: 'sparring_rounds', label: 'Sparring rounds', unit: null, value: 2 }]
			: [])
	];
	await db.insert(otherSessionRecords).values({
		...{ ownerId: owner, workoutId: id, kind: 'class', durationMinutes: 90, rpe: 7 },
		metrics
	});
	return id;
}

async function recoveryNote(db: Executor, owner: string, notedOn: IsoDate, n: number) {
	await db.insert(recoveryNotes).values({
		...{ ownerId: owner, clientMutationId: crypto.randomUUID(), notedOn },
		...{ sleepHours: 7 + 0.5 * (n % 3), soreness: 2 + (n % 2), energy: 4 - (n % 2), stress: 2 },
		note: n === WEEKS ? 'Legs heavy after the long run' : null
	});
}

// ---- the owner --------------------------------------------------------------------------------

async function profile(db: Executor, owner: string) {
	const deps = { db };
	await saveBasics(
		owner,
		{ name: 'Niko', weightUnit: 'kg', distanceUnit: 'km', timeZone: TZ },
		deps
	);
	await saveBody(owner, { weightUnit: 'kg', bodyWeight: 82, nutritionPhase: 'cut' }, deps);
	const goal = await createGoal(
		owner,
		{
			kind: 'general',
			title: 'Build muscle',
			disciplines: ['hypertrophy', 'running', 'muay_thai'],
			focus: 'More muscle while the long run grows',
			measure: 'Hard sets per muscle group and long-run distance'
		},
		deps
	);
	const tested = { lift: 'bench_press', source: 'tested', value: 100, unit: 'kg' };
	await saveBaselines(
		owner,
		{
			unknown: false,
			lifts: [
				{ lift: 'back_squat', source: 'estimate', value: 140, unit: 'kg' },
				{ ...tested, achievedOn: addDays(weekOf(5), 4) },
				{ lift: 'deadlift', source: 'estimate', value: 170, unit: 'kg' }
			]
		},
		deps
	);
	const race = { distance: '10k', timeSeconds: 2880, racedOn: addDays(weekOf(8), 6) };
	await saveSpecifics(
		owner,
		{
			running: {
				...{ unit: 'km', weeklyDistance: 25, runsPerWeek: 3, longestRun: 12 },
				...{ easyPaceSeconds: 330, races: [{ ...race, eventName: 'Riverside 10K' }] }
			},
			muayThai: { sessionsPerWeek: 1, sparringPerWeek: 0, fights: 0 }
		},
		deps
	);
	const schedule = await saveSchedule(
		owner,
		{
			daysPerWeek: 6,
			availableDays: ['mon', 'tue', 'wed', 'thu', 'sat', 'sun'],
			preferredTimes: ['morning', 'evening'],
			sessionMinutes: 60,
			commitments: [
				{
					...{ discipline: 'muay_thai', label: 'Muay Thai class', days: ['tue'] },
					...{ timeOfDay: 'evening', durationMinutes: 90, intensity: 'hard', notes: null }
				}
			]
		},
		deps
	);
	return { goal: goal.id, commitment: schedule.commitments[0]!.id };
}

/** Store `plan` with today's profile as its generator input, as a build stores it. */
async function storeProgram(db: Executor, owner: string, plan: ProgramPlan) {
	const input = buildProgrammingInput(await getTrainingProfile(owner, { db }), {
		catalogue: CATALOGUE
	});
	const origin = {
		...{ source: 'rules' as const, generator: GENERATOR_ID },
		...{
			digest: catalogueDigest(CATALOGUE, []),
			snapshot: input as unknown as Record<string, unknown>
		}
	};
	const now = () => atLocal(addDays(plan.startsOn, -2), '12:00', TZ);
	return (await createProgramFromPlan(owner, plan, origin, { db, now })).programId;
}

const sessionsOf = (version: Awaited<ReturnType<typeof getProgramVersion>>) =>
	version.blocks.flatMap((b) => b.weeks.flatMap((w) => w.sessions));

const BENCH_SET = (n: number): SetSpec => ({
	key: 'bench_press',
	weight: BENCH[n - 1]!,
	reps: 5,
	rpe: BENCH_RPE[n - 1]!
});

const strengthA = (n: number): SetSpec[] => [
	{ key: 'back_squat', weight: 60, reps: 5, rpe: null, warmup: true },
	...sets(3, { key: 'back_squat', weight: squatKg(n), reps: 5, rpe: 8 }).map((s, i) =>
		n === 5 && i === 2 ? { ...s, deleted: true } : s
	),
	...sets(3, BENCH_SET(n)),
	...(n === 2 ? [{ ...BENCH_SET(n), extra: true }] : []),
	...sets(3, { key: 'barbell_row', weight: 60, reps: 8, rpe: 7 })
];

const strengthB = (n: number): SetSpec[] => [
	{ key: 'deadlift', weight: 80, reps: 5, rpe: null, warmup: true },
	...sets(2, { key: 'deadlift', weight: deadliftKg(n), reps: 5, rpe: n === 8 ? 9 : 8 }),
	...sets(3, { key: 'dumbbell_curl', weight: 14, reps: 10, rpe: 8 }).map((s, i) =>
		n === 3 && i === 2 ? { ...s, skipped: true } : s
	)
];

/** Seed the dataset; every write goes through `db` (a test's transaction). */
export async function seedDataset(db: Executor): Promise<Dataset> {
	const deps = { db };
	const owner = await makeOwner(db);
	const { goal, commitment } = await profile(db, owner);
	const found = await resolveKeys(KEYS, deps);
	const ids = Object.fromEntries(KEYS.map((k) => [k, found.get(k)!.id])) as Record<Key, string>;
	const at = (date: IsoDate, time: string) => atLocal(date, time, TZ);
	const findIn = (all: StoredSession[], date: IsoDate, title: string) =>
		all.find((s) => s.date === date && s.title === title)!;

	// Program A, built during the cut; version 2 from week 3's bench adjustment.
	const a = await storeProgram(
		db,
		owner,
		programPlan(
			'Muscle on a cut',
			[
				['A1', 1, 3],
				['A2', 4, 6]
			],
			commitment,
			goal
		)
	);
	const a1 = sessionsOf(await getProgramVersion(owner, a, 1, deps));
	const underV1Row = findIn(a1, weekOf(3), 'Strength A');
	const bench = underV1Row.kind === 'strength' ? underV1Row.exercises[1]! : null;
	const adjust = {
		...{ sessionLineage: underV1Row.lineage, plannedExerciseLineage: bench!.lineage },
		...{ position: 1, sets: 4, reason: 'Bench feels good' }
	};
	await adjustPrescription(owner, adjust, { version: 1, today: weekOf(3) }, deps);
	const a2 = sessionsOf(await getProgramVersion(owner, a, 2, deps));

	// Program B, after A is archived and the cut is over; version 2 skips week 9's tempo run.
	const archivedAt = at(addDays(weekOf(6), 6), '21:00');
	await db.update(programs).set({ status: 'archived', archivedAt }).where(eq(programs.id, a));
	await saveBody(owner, { weightUnit: 'kg', bodyWeight: 80, nutritionPhase: null }, deps);
	const bPlan = programPlan(
		'Muscle and miles',
		[
			['B1', 7, 11],
			['B2', 12, 16],
			['B3', 17, 20, true]
		],
		commitment,
		goal
	);
	const b = await storeProgram(db, owner, bPlan);
	const b1 = sessionsOf(await getProgramVersion(owner, b, 1, deps));
	const skipped = findIn(b1, addDays(weekOf(9), 3), 'Tempo run');
	const skip = { sessionLineage: skipped.lineage, reason: 'Sore calf' };
	await skipSession(owner, skip, { version: 1, today: weekOf(9) }, deps);
	const b2 = sessionsOf(await getProgramVersion(owner, b, 2, deps));

	const missed = findIn(b2, addDays(weekOf(10), 5), 'Long run');
	const abandonedRow = findIn(b2, addDays(weekOf(12), 2), 'Strength B');
	const leaveOut = new Set([skipped.lineage, missed.lineage, abandonedRow.lineage]);
	/**
	 * The version a workout of `s` was logged under: the one current that day. Week 3's Monday
	 * workout started before that day's edit, so it stays under version 1.
	 */
	const current = (s: StoredSession): [StoredSession[], string] => {
		if (s.date < weekOf(7)) return [s.date <= weekOf(3) ? a1 : a2, a];
		return [s.date < weekOf(9) ? b1 : b2, b];
	};

	const workoutIds = { underV1: '', abandoned: '', other: [] as string[] };
	const setIds = { extra: '', skipped: '', deleted: '', edited: '' };
	for (let n = 1; n <= WEEKS; n++) {
		const planned = (n <= 6 ? a2 : b2).filter(
			(s) => s.date >= weekOf(n) && s.date < weekOf(n + 1) && !leaveOut.has(s.lineage)
		);
		for (const s of planned) {
			const [version, programId] = current(s);
			const row = findIn(version, s.date, s.title);
			const w = { planned: row, programId, title: s.title };
			if (s.kind === 'strength') {
				const isA = s.title === 'Strength A';
				const logged = await lifting(
					db,
					owner,
					ids,
					{ ...w, at: at(s.date, '07:00'), sessionType: 'strength', minutes: 65 },
					isA ? strengthA(n) : strengthB(n)
				);
				if (row === underV1Row) workoutIds.underV1 = logged.id;
				if (isA && n === 2) setIds.extra = logged.setIds[7]!;
				if (isA && n === 5) setIds.deleted = logged.setIds[3]!;
				if (isA && n === 6) setIds.edited = logged.setIds[4]!;
				if (!isA && n === 3) setIds.skipped = logged.setIds[5]!;
			} else if (s.kind === 'run') {
				const time = s.type === 'long_run' ? '08:00' : '06:30';
				await running(db, owner, { ...w, at: at(s.date, time), type: s.type, n });
			} else {
				await muayThai(db, owner, { ...w, at: at(s.date, '19:00') }, n);
			}
		}
		await recoveryNote(db, owner, weekOf(n), n);
	}

	// Week 6's first working bench set, edited after the session: 85 kg at RPE 9.
	const edited = {
		weight: 85,
		unit: 'kg' as const,
		reps: 5,
		rpe: 9,
		isWarmup: false,
		isSkipped: false
	};
	await db
		.update(setRecords)
		.set({ weight: 85, rpe: 9, e1rmKg: setE1rm(edited)!.value })
		.where(eq(setRecords.id, Number(setIds.edited)));

	// Off plan: a Sunday-night session, and the three discarded workouts with live sets.
	const sundayNight = await lifting(
		db,
		owner,
		ids,
		{
			at: at(addDays(weekOf(4), 6), '23:00'),
			title: 'Late arms',
			sessionType: 'hypertrophy',
			minutes: 35
		},
		[
			{ key: 'dumbbell_curl', weight: 14, reps: 10, rpe: 8, minute: 10 },
			{ key: 'dumbbell_curl', weight: 14, reps: 10, rpe: 8, minute: 30 }
		]
	);
	const abandoned = await lifting(
		db,
		owner,
		ids,
		{
			...{ planned: abandonedRow, programId: b, title: abandonedRow.title },
			...{ at: at(abandonedRow.date, '07:00'), sessionType: 'strength', minutes: 20 },
			status: 'abandoned'
		},
		sets(2, { key: 'deadlift', weight: 250, reps: 3, rpe: 9 })
	);
	const deleted = await lifting(
		db,
		owner,
		ids,
		{
			at: at(addDays(weekOf(13), 4), '18:00'),
			title: 'Arms',
			sessionType: 'hypertrophy',
			minutes: 30,
			deleted: true
		},
		sets(3, { key: 'dumbbell_curl', weight: 30, reps: 10, rpe: 8 })
	);
	const abandonedRun = await running(db, owner, {
		...{ at: at(addDays(weekOf(14), 4), '06:30'), title: 'Easy run' },
		...{ type: 'easy_run', n: 14, status: 'abandoned' }
	});
	const inProgress = await lifting(
		db,
		owner,
		ids,
		{
			at: at(LAST_DAY, '17:00'),
			title: 'Full body',
			sessionType: 'strength',
			minutes: 30,
			status: 'in_progress'
		},
		sets(2, { key: 'back_squat', weight: 200, reps: 5, rpe: 9 })
	);

	// A second owner in week 5. The app allows one owner, so the seed lifts that rule inside the
	// test's transaction only (Postgres DDL rolls back with it).
	await db.execute(sql`drop index owners_singleton_uq`);
	await db.execute(sql`alter table owners drop constraint owners_singleton_ck`);
	const other = await makeOwner(db, 'Second owner');
	await saveBasics(
		other,
		{ name: 'Sam', weightUnit: 'kg', distanceUnit: 'km', timeZone: TZ },
		deps
	);
	const theirs = await lifting(
		db,
		other,
		ids,
		{ at: at(weekOf(5), '07:00'), title: 'Squat day', sessionType: 'strength', minutes: 40 },
		sets(3, { key: 'back_squat', weight: 300, reps: 5, rpe: 8 })
	);
	const theirRun = await running(db, other, {
		at: at(addDays(weekOf(5), 1), '06:30'),
		title: 'Run',
		type: 'long_run',
		n: 20
	});
	await recoveryNote(db, other, weekOf(5), 1);

	return {
		owner,
		other,
		programs: { a, b },
		exercises: ids,
		workouts: {
			...{ abandoned: abandoned.id, inProgress: inProgress.id, deleted: deleted.id },
			...{ abandonedRun, sundayNight: sundayNight.id, underV1: workoutIds.underV1 },
			other: [theirs.id, theirRun]
		},
		sets: { sundayNight: sundayNight.setIds[1]!, ...setIds },
		sessions: {
			...{ underV1Row: underV1Row.id, underV1: underV1Row.lineage, skipped: skipped.lineage },
			...{ missed: missed.lineage, abandoned: abandonedRow.lineage }
		},
		adjustedBench: bench!.lineage
	};
}
