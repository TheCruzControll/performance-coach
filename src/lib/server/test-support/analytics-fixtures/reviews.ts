/**
 * The review fixtures (M6 review-test-support): the weeks and blocks the weekly and cycle review
 * services' integration tests and the review specs start from. Like the dashboard fixtures they
 * are written through the real services (M2's profile, M3's program store and logging) at dates
 * counted from the owner's today (SeedContext), so each holds on any weekday. Integration tests
 * call them through seedAnalyticsFixture with a forced `now`; specs through
 * e2e/review-support.ts.
 *
 * Every program is one four-week block (Base) of the same week, Monday to Saturday: Strength A
 * (squat and bench), a Muay Thai class (Tue evening), an easy run, Strength B (deadlift and
 * bench), sparring (Fri evening) and a long run (Sat). Lifts are prescribed at RPE 8 (6 in a
 * deload) and logged at it, except in the 'hard' week. Every session dated before today is
 * logged as planned; today's are logged only where the scenario says so.
 *
 * - week-almost-complete: the block's last week is this week, planned only up to today, and
 *   today holds Strength C (morning) and an easy run (evening). Strength C is logged; the run,
 *   today's last session, is still to log (lineages.pending).
 * - week-complete: last week is the reviewed one and the hard week: bench logged at RPE 7 against
 *   8 in both strength sessions, and Friday's sparring at RPE 9 with 6 sparring rounds before
 *   Saturday's long run (workouts.sparring, workouts.longRun). Next week, this one, is planned.
 * - week-late: the reviewed (hard) week is LATE_WEEKS before this one, so it ended 8 to 14 days
 *   ago (9 on a Tuesday) and the week after it has ended too.
 * - next-week-deload: week-complete, but this week, the reviewed week's next, is a planned
 *   deload.
 * - block-end: as week-almost-complete with today's run logged too, so the block's last week is
 *   fully logged; an outline block (Build) starts next Monday.
 * - block-end-late: the same block, ended BLOCK_LATE_WEEKS weeks before this week ends, every
 *   session logged, and nothing planned since.
 *
 * Each returns, besides the ids, `review`: the week (and its next week) or the block to review.
 * TEST ONLY, like the rest of this folder.
 */
import { addDays, type IsoDate } from '../../../domain/calendar';
import { CATALOGUE } from '../../../domain/exercises/index';
import { buildProgrammingInput, catalogueDigest, GENERATOR_ID } from '../../../domain/programming';
import type {
	BlockPlan,
	PlannedExercisePlan,
	ProgramPlan,
	SessionPlan,
	SetPrescription,
	WeekPlan
} from '../../../domain/training/types';
import type { SessionType } from '../../../domain/training/vocabulary';
import { resolveKeys } from '../../services/exercises/index';
import { createGoal, getTrainingProfile, saveSchedule } from '../../services/profile/index';
import {
	createProgramFromPlan,
	getProgramVersion,
	type StoredSession
} from '../../services/programs/index';
import {
	finishWorkout,
	logOtherSession,
	logRun,
	logSet,
	startWorkout
} from '../../services/training/log';
import { atLocal } from './dashboards';
import type { AnalyticsFixture, FixtureResult, SeedContext } from './index';

/** Weeks in the reviewed block; weeks in the outline after it (block-end). */
export const BLOCK_WEEKS = 4;
export const OUTLINE_WEEKS = 4;
/**
 * week-late reviews the week this many weeks before this one, so it ended 8 to 14 days before
 * today (9 on a Tuesday): no weekday can make it exactly 9, and 2 keeps the week after it ended.
 */
export const LATE_WEEKS = 2;
/** block-end-late: the block ended this many weeks before this week ends (owner decision). */
export const BLOCK_LATE_WEEKS = 3;
/** The lifts' target RPE, and what the hard week's bench is logged at: about 1 under. */
export const TARGET_RPE = 8;
export const UNDER_TARGET_RPE = 7;
const DELOAD_RPE = 6;

/** What the review services are asked to review. */
export type ReviewTarget =
	| { kind: 'weekly'; weekStartsOn: IsoDate; nextWeekStartsOn: IsoDate }
	| { kind: 'cycle'; blockLineageId: string; blockStartsOn: IsoDate; blockEndsOn: IsoDate };

export interface ReviewFixtureResult extends FixtureResult {
	review: ReviewTarget;
}

export const KEYS = ['back_squat', 'bench_press', 'deadlift'] as const;
export type Key = (typeof KEYS)[number];
/** Week w's working load (w counted from 0 in the block): +2.5 kg a week. */
const LOAD: Record<Key, number> = { back_squat: 100, bench_press: 80, deadlift: 140 };

// ---- the plan ---------------------------------------------------------------------------------

const rx = (rpe: number): SetPrescription => ({
	...{ role: 'working', sets: 3, repsMin: 5, repsMax: 5, targetRpe: rpe, loadKind: 'rpe_based' },
	...{ seconds: null, metres: null, loadValue: null, loadUnit: null, loadBasis: null },
	...{ reference1rm: null, reference1rmUnit: null, tempo: null, notes: null, restSeconds: 150 }
});

const lift = (key: Key, rpe: number): PlannedExercisePlan => ({
	...{ exercise: { key }, sets: [rx(rpe)], baselineLift: null, superset: null },
	...{ substitutedFrom: null, substitutionReason: null, instructions: null, notes: null }
});

type Slot = { orderInDay: number; timeOfDay: 'morning' | 'evening' };
const MORNING: Slot = { orderInDay: 1, timeOfDay: 'morning' };
const EVENING: Slot = { orderInDay: 1, timeOfDay: 'evening' };

const base = (date: IsoDate, title: string, minutes: number, rpe: number, slot: Slot) => ({
	...{ date, title, ...slot, estMinutes: minutes, targetRpe: rpe, estLoad: minutes * rpe },
	...{ customDiscipline: null, commitmentRef: null, instructions: null, notes: null },
	intensity: rpe >= 8 ? ('hard' as const) : ('moderate' as const),
	source: 'generator' as const
});

function strength(date: IsoDate, title: string, keys: Key[], rpe: number, slot = MORNING) {
	const exercises = keys.map((key) => lift(key, rpe));
	return {
		...base(date, title, 60, rpe, slot),
		kind: 'strength' as const,
		type: 'strength' as const,
		discipline: 'strength' as const,
		exercises
	} satisfies SessionPlan;
}

function run(date: IsoDate, type: SessionType, title: string, metres: number, slot = MORNING) {
	const segment = {
		...{ kind: type === 'long_run' ? ('long' as const) : ('easy' as const), repeatGroup: null },
		...{ repeats: null, distanceMetres: metres, durationSeconds: null, hrZone: null },
		...{ targetRpe: null, paceMinSecondsPerKm: null, paceMaxSecondsPerKm: null }
	};
	return {
		...base(date, title, Math.round(metres / 180), 5, slot),
		kind: 'run' as const,
		type,
		discipline: 'running' as const,
		segments: [segment]
	} satisfies SessionPlan;
}

function muayThai(date: IsoDate, kind: 'class' | 'sparring', commitment: string | null) {
	const title = kind === 'class' ? 'Muay Thai class' : 'Sparring';
	return {
		...base(date, title, 90, 7, EVENING),
		...(commitment ? { source: 'commitment' as const, commitmentRef: commitment } : {}),
		kind: 'other' as const,
		type: 'muay_thai' as const,
		discipline: 'muay_thai' as const,
		details: { kind, durationMinutes: 90, targetRpe: 7, metrics: [], notes: null }
	} satisfies SessionPlan;
}

/** The week from `monday`; with `cutAt` (today), only what comes before today, then Strength C
 * and an evening easy run today. */
function weekSessions(monday: IsoDate, rpe: number, commitment: string, cutAt?: IsoDate) {
	const day = (d: number) => addDays(monday, d);
	const all: SessionPlan[] = [
		strength(day(0), 'Strength A', ['back_squat', 'bench_press'], rpe),
		muayThai(day(1), 'class', commitment),
		run(day(2), 'easy_run', 'Easy run', 6000),
		strength(day(3), 'Strength B', ['deadlift', 'bench_press'], rpe),
		muayThai(day(4), 'sparring', null),
		run(day(5), 'long_run', 'Long run', 14000)
	];
	if (!cutAt) return all;
	return [
		...all.filter((s) => s.date < cutAt),
		strength(cutAt, 'Strength C', ['back_squat', 'bench_press'], rpe),
		run(cutAt, 'easy_run', 'Easy run', 5000, { orderInDay: 2, timeOfDay: 'evening' })
	];
}

const TARGETS = {
	deload: { rpeCap: DELOAD_RPE, volumeFactor: 0.6, loadStep: -0.1, runVolumeFactor: 0.7 },
	accumulation: { rpeCap: TARGET_RPE, volumeFactor: 1, loadStep: 0.025, runVolumeFactor: 1 }
};

function week(monday: IsoDate, kind: 'accumulation' | 'deload', sessions: SessionPlan[]): WeekPlan {
	return { kind, startsOn: monday, endsOn: addDays(monday, 6), targets: TARGETS[kind], sessions };
}

const block = (name: string, weeks: WeekPlan[], goal: string, outline = false): BlockPlan => ({
	...{ phase: 'accumulation', name, startsOn: weeks[0]!.startsOn, endsOn: weeks.at(-1)!.endsOn },
	...{ outline, goalRefs: [goal], weeks },
	progression: outline ? {} : { rpeStepPerWeek: 0, rpeCap: TARGET_RPE }
});

// ---- the scenarios ----------------------------------------------------------------------------

export interface Layout {
	/** The block's first week, in weeks from this one. */
	first: number;
	/** The block's last week's kind. */
	lastKind: 'accumulation' | 'deload';
	/** The block's last week is this week, planned up to today (weekSessions' cutAt). */
	cut?: boolean;
	/** An outline block of OUTLINE_WEEKS from the Monday after the block. */
	outline?: boolean;
	/** The week, in weeks from this one, whose bench is under target and sparring hard (or weeks). */
	hard?: number | number[];
	/** Of today's sessions, in their order: all logged, or all but the last. */
	today?: 'all' | 'all_but_last';
}

/** A goal and a schedule with the Tuesday class: what buildProgrammingInput needs. */
async function profile(ctx: SeedContext) {
	const deps = { db: ctx.db };
	const goal = await createGoal(
		ctx.ownerId,
		{
			kind: 'general',
			title: 'Stronger and fitter',
			disciplines: ['strength', 'running', 'muay_thai'],
			focus: 'Lifts up while the long run holds',
			measure: 'Working sets and long-run distance'
		},
		deps
	);
	const commitment = {
		...{ discipline: 'muay_thai', label: 'Muay Thai class', days: ['tue'] },
		...{ timeOfDay: 'evening', durationMinutes: 90, intensity: 'hard', notes: null }
	};
	const schedule = await saveSchedule(
		ctx.ownerId,
		{
			daysPerWeek: 6,
			availableDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
			preferredTimes: ['morning', 'evening'],
			sessionMinutes: 60,
			commitments: [commitment]
		},
		deps
	);
	return { goal: goal.id, commitment: schedule.commitments[0]!.id };
}

/** The plan, as `layout` says, stored with the profile's generator input as its origin. */
async function storeProgram(ctx: SeedContext, layout: Layout) {
	const deps = { db: ctx.db };
	const { goal, commitment } = await profile(ctx);
	const start = addDays(ctx.weekStart, 7 * layout.first);
	const weeks = Array.from({ length: BLOCK_WEEKS }, (_, i) => {
		const monday = addDays(start, 7 * i);
		const kind = i === BLOCK_WEEKS - 1 ? layout.lastKind : 'accumulation';
		const cutAt = layout.cut && monday === ctx.weekStart ? ctx.today : undefined;
		const rpe = kind === 'deload' ? DELOAD_RPE : TARGET_RPE;
		return week(monday, kind, weekSessions(monday, rpe, commitment, cutAt));
	});
	const after = addDays(weeks.at(-1)!.endsOn, 1);
	const outline = Array.from({ length: OUTLINE_WEEKS }, (_, i) =>
		week(addDays(after, 7 * i), 'accumulation', [])
	);
	const plan: ProgramPlan = {
		title: 'Strength, running and Muay Thai',
		startsOn: start,
		firstPlannedDay: start,
		blocks: [
			block('Base', weeks, goal),
			...(layout.outline ? [block('Build', outline, goal, true)] : [])
		],
		decisions: [
			{
				kind: 'program_purpose',
				ruleKey: 'blocks.default',
				summary: 'Strength, running and Muay Thai together',
				why: 'Review fixture: two lifting days, two runs, the class and sparring.',
				decidedBy: 'rules',
				refs: ['blocks.0'],
				evidence: {}
			}
		]
	};
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

const TIMES = { morning: '07:00', evening: '19:00' } as const;

/** When a session of `minutes` on `date` starts: its usual time, but on today never so late that
 * it ends after now (and never before 00:05). */
function startOf(ctx: SeedContext, s: StoredSession, minutes: number): Date {
	const at = atLocal(
		s.date,
		TIMES[s.timeOfDay === 'evening' ? 'evening' : 'morning'],
		ctx.timeZone
	);
	if (s.date !== ctx.today) return at;
	const latest = ctx.now.getTime() - (minutes + 5) * 60_000;
	const floor = atLocal(ctx.today, '00:05', ctx.timeZone).getTime();
	return new Date(Math.max(floor, Math.min(at.getTime(), latest)));
}

/** Log planned session `s` of block week `w` (from 0) as planned, or as the hard week has it. */
export async function logSession(
	ctx: SeedContext,
	ids: Record<Key, string>,
	s: StoredSession,
	w: number,
	hard: boolean
) {
	const deps = { db: ctx.db };
	const minutes = s.kind === 'run' ? s.estMinutes : s.kind === 'other' ? 90 : 60;
	const at = startOf(ctx, s, minutes);
	const clientId = crypto.randomUUID();
	const workout = { clientId, kind: s.kind, discipline: s.discipline, sessionType: s.type };
	const started = {
		...workout,
		title: s.title,
		plannedSessionId: s.id,
		startedAt: at.toISOString()
	};
	const { workout: row } = await startWorkout(ctx.ownerId, started, deps);
	let rpe = 7;
	if (s.kind === 'strength') {
		let n = 0;
		for (const [position, planned] of s.exercises.entries()) {
			const key = (planned.exercise as { key: Key }).key;
			const target = planned.sets[0]!.targetRpe!;
			rpe = hard && key === 'bench_press' ? UNDER_TARGET_RPE : target;
			for (let setIndex = 1; setIndex <= 3; setIndex++) {
				const set = {
					...{ clientMutationId: crypto.randomUUID(), workoutClientId: clientId },
					...{ exerciseId: ids[key], plannedExerciseLineageId: planned.lineage },
					...{ exercisePosition: position + 1, setIndex, weight: LOAD[key] + 2.5 * w },
					...{ unit: 'kg', reps: 5, missedReps: 0, rpe, seconds: null, metres: null },
					...{ isExtra: false, isSkipped: false, isWarmup: false },
					performedAt: new Date(at.getTime() + 5 * ++n * 60_000).toISOString()
				};
				await logSet(ctx.ownerId, set, deps);
			}
		}
		rpe = s.targetRpe ?? TARGET_RPE;
	} else if (s.kind === 'run') {
		const metres = s.segments[0]!.distanceMetres!;
		const seconds = Math.round(metres * 0.33);
		const distance = { value: metres, unit: 'm' };
		const segment = {
			clientMutationId: crypto.randomUUID(),
			position: 1,
			kind: s.segments[0]!.kind
		};
		const segments = [{ ...segment, distance, durationSeconds: seconds, avgHr: null, rpe: null }];
		rpe = s.type === 'long_run' ? 6 : 4;
		const logged = { distance, durationSeconds: seconds, avgHr: null, rpe, notes: null, segments };
		await logRun(ctx.ownerId, { workoutClientId: clientId, ...logged }, deps);
	} else if (s.kind === 'other') {
		const sparring = s.details.kind === 'sparring';
		rpe = sparring && hard ? 9 : 7;
		const metrics = sparring
			? [{ key: 'sparring_rounds', label: 'Sparring rounds', unit: null, value: hard ? 6 : 3 }]
			: [];
		const session = { kind: s.details.kind, durationMinutes: 90, rpe, metrics, notes: null };
		await logOtherSession(ctx.ownerId, { workoutClientId: clientId, ...session }, deps);
	}
	const finishedAt = new Date(at.getTime() + minutes * 60_000).toISOString();
	const done = { status: 'completed', finishedAt, durationSeconds: minutes * 60, sessionRpe: rpe };
	await finishWorkout(ctx.ownerId, clientId, done, deps);
	return row.id;
}

/** Store the layout's program and log it: the fixture's ids, and the block it reviews. */
async function seedLayout(ctx: SeedContext, layout: Layout) {
	const programId = await storeProgram(ctx, layout);
	const found = await resolveKeys(KEYS, { db: ctx.db });
	const ids = Object.fromEntries(KEYS.map((k) => [k, found.get(k)!.id])) as Record<Key, string>;
	const version = await getProgramVersion(ctx.ownerId, programId, 1, { db: ctx.db });
	const first = version.blocks[0]!;
	const todays = first.weeks.flatMap((w) => w.sessions).filter((s) => s.date === ctx.today);
	const lastToday = todays.at(-1);
	const result: FixtureResult = {
		programId,
		historyStart: first.startsOn,
		exercises: ids,
		workouts: {},
		lineages: {}
	};
	for (const [w, planned] of first.weeks.entries()) {
		const hard = [layout.hard ?? []].flat().some((h) => planned.startsOn === weekAt(ctx, h));
		for (const s of planned.sessions) {
			const logged =
				s.date < ctx.today ||
				(s.date === ctx.today &&
					(layout.today === 'all' || (layout.today === 'all_but_last' && s !== lastToday)));
			if (!logged) {
				if (s === lastToday && layout.today === 'all_but_last') result.lineages.pending = s.lineage;
				continue;
			}
			const id = await logSession(ctx, ids, s, w, hard);
			if (hard && s.kind === 'other' && s.details.kind === 'sparring')
				result.workouts.sparring = id;
			if (hard && s.type === 'long_run') result.workouts.longRun = id;
		}
	}
	return { result, block: first };
}

const weekAt = (ctx: SeedContext, offset: number) => addDays(ctx.weekStart, 7 * offset);

/** A weekly scenario: the week `reviewed` weeks from this one is the one to review. */
export const weekly =
	(layout: Layout, reviewed: number): AnalyticsFixture =>
	async (ctx): Promise<ReviewFixtureResult> => {
		const { result } = await seedLayout(ctx, layout);
		const weekStartsOn = weekAt(ctx, reviewed);
		const nextWeekStartsOn = addDays(weekStartsOn, 7);
		return { ...result, review: { kind: 'weekly', weekStartsOn, nextWeekStartsOn } };
	};

/** A cycle scenario: the block is the one to review. */
const cycle =
	(layout: Layout): AnalyticsFixture =>
	async (ctx): Promise<ReviewFixtureResult> => {
		const { result, block } = await seedLayout(ctx, layout);
		const { lineage: blockLineageId, startsOn: blockStartsOn, endsOn: blockEndsOn } = block;
		return { ...result, review: { kind: 'cycle', blockLineageId, blockStartsOn, blockEndsOn } };
	};

export const fixtures = {
	'week-almost-complete': weekly(
		{
			first: 1 - BLOCK_WEEKS,
			lastKind: 'accumulation',
			cut: true,
			outline: true,
			today: 'all_but_last'
		},
		0
	),
	'week-complete': weekly(
		{ first: 1 - BLOCK_WEEKS, lastKind: 'accumulation', outline: true, hard: -1 },
		-1
	),
	'week-late': weekly(
		{ first: 1 - BLOCK_WEEKS, lastKind: 'accumulation', outline: true, hard: -LATE_WEEKS },
		-LATE_WEEKS
	),
	'next-week-deload': weekly(
		{ first: 1 - BLOCK_WEEKS, lastKind: 'deload', outline: true, hard: -1 },
		-1
	),
	'block-end': cycle({
		first: 1 - BLOCK_WEEKS,
		lastKind: 'accumulation',
		cut: true,
		outline: true,
		today: 'all'
	}),
	'block-end-late': cycle({ first: 1 - BLOCK_WEEKS - BLOCK_LATE_WEEKS, lastKind: 'accumulation' })
} satisfies Record<string, AnalyticsFixture>;
