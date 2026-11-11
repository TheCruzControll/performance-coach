/**
 * The Strength view's facts summed one Monday-to-Sunday week at a time (PRD §10; the closed-week
 * rollups): what each strength figure reads of a week's counted sets, worked out once, so a closed
 * week is summed when it is written (strength_week_rollups) and only the week in progress on each
 * request. Every value is the one strength.ts and prescribed.ts give the same sets, and the
 * dashboard joins weeks with the same functions, so a figure is the same whichever way it is read.
 *
 * - A week is the owner's Monday-to-Sunday week (M3's weekStartOf). Tonnage, hard sets and the
 *   weekly RPE are byWeek's totals and means; each exercise keeps keyLifts' stats and its rated
 *   working sets' RPE, in the order performed.
 * - A session (one exercise in one workout) belongs to the week of its first set, with its e1RM
 *   point and its bests. Of those bests a week keeps only the ones that beat an earlier session's
 *   of the same week (prsOf): a best that does not is never a PR, nor the record a PR beats.
 * - An exposure belongs to the week its workout started in.
 * - Summed from the facts of several weeks at once, a workout whose sets run into the next week
 *   stays one session, as the facts loader's rows give it. A week summed alone holds only what it
 *   would hold summed with its neighbours when none of its workouts has a set or its start in
 *   another week; the rollups keep such a week only (services/analytics/strength-weeks.ts).
 * - Plain data (JSON): an instant is its milliseconds.
 *
 * Conventions for src/lib/domain/analytics (M6): pure, imported by path (no index file), no zod,
 * no runtime import of domain/programming or domain/exercises. Server-only at runtime.
 */
import { addDays, daysBetween, mondayOf } from '../calendar.ts';
import type { IsoDate } from '../calendar.ts';
import { localDay } from '../dates.ts';
import type { WeightUnit } from '../units.ts';
import { isWorking } from '../workout/logging.ts';
import { above } from '../workout/summary.ts';
import { exposure, matchPrescription } from './prescribed.ts';
import type { ActualSet, Exposure, PlannedLines } from './prescribed.ts';
import {
	hardSetsByWeek,
	liftStats,
	rpeByWeek,
	strengthSessions,
	tonnageByWeek
} from './strength.ts';
import type {
	E1rmPoint,
	HardSetCount,
	SessionBest,
	StrengthExercise,
	StrengthFact,
	StrengthSession
} from './strength.ts';

/** A counted set, as the facts loader gives it. */
export type WeekFact = StrengthFact & ActualSet;

/** A session as a week keeps it: its bests are those that beat an earlier one of the week. */
export type WeekSession = StrengthSession;

/** One exercise's sets in a week. */
export interface WeekLift {
	exercise: string;
	/** keyLifts' stats: the workouts with a working set of it, the latest one's instant (0: none), e1RM. */
	workouts: string[];
	last: number;
	e1rm: boolean;
	/** The RPE of each rated working set, in the order performed. */
	rpes: number[];
	/** Its sessions whose first set fell in the week, oldest first. */
	sessions: WeekSession[];
}

/** What the RPE-against-target figures read of an exposure. */
export type WeekExposure = Pick<
	Exposure,
	'day' | 'exerciseId' | 'substituted' | 'rpeDeviations' | 'rpeTargets'
>;

export interface StrengthWeek {
	weekStart: IsoDate;
	/** The day of its first set; null for a week with none. */
	firstDay: IsoDate | null;
	/** tonnageByWeek's value; null with nothing lifted. */
	tonnage: number | null;
	/** hardSetsByWeek's; null without a hard set. */
	hardSets: HardSetCount | null;
	/** rpeByWeek's mean; null without a rated working set. */
	rpe: number | null;
	/** The RPE of each rated working set, in the order performed. */
	rpes: number[];
	/** Each exercise with a set in the week, in the order first performed. */
	lifts: WeekLift[];
	/** The exposures of the strength workouts started in the week; null when not summed. */
	exposures: WeekExposure[] | null;
}

/** A counted workout, as the exposures read it. */
export interface WeekWorkout {
	id: string;
	kind: string;
	plannedSessionId: string | null;
	/** The owner's day it started. */
	date: IsoDate;
}

/** What the exposures are matched against: the workouts, their planned lines and the unit. */
export interface WeekPlan {
	workouts: readonly WeekWorkout[];
	prescriptions: ReadonlyMap<string, readonly PlannedLines[]>;
	unit: WeightUnit;
}

/** Of each session's bests, those that beat an earlier session's in the list: prsOf's rule. */
function improving(sessions: readonly StrengthSession[]): WeekSession[] {
	const held = new Map<string, number>();
	return sessions.map((session) => ({
		...session,
		bests: session.bests.filter(({ kind, reps, value }: SessionBest) => {
			const key = `${kind}:${reps ?? ''}`;
			const record = held.get(key);
			if (record !== undefined && !above(value, record)) return false;
			held.set(key, value);
			return true;
		})
	}));
}

/** The exposures of `plan`'s strength workouts against `facts`, as the Strength view matches them. */
function exposuresOf(facts: readonly WeekFact[], plan: WeekPlan): WeekExposure[] {
	const byWorkout = Map.groupBy(facts, (set) => set.workoutId);
	return plan.workouts.flatMap((workout) => {
		const planned = workout.plannedSessionId && plan.prescriptions.get(workout.plannedSessionId);
		if (workout.kind !== 'strength' || !planned) return [];
		const logged = (byWorkout.get(workout.id) ?? []).toSorted(
			(a, b) => a.setIndex - b.setIndex || a.performedAt.getTime() - b.performedAt.getTime()
		);
		return planned.map((lines) => {
			const e = exposure(matchPrescription(lines, logged, { unit: plan.unit }), workout.date);
			const { day, exerciseId, substituted, rpeDeviations, rpeTargets } = e;
			return { day, exerciseId, substituted, rpeDeviations, rpeTargets };
		});
	});
}

/**
 * What a reader of the weeks needs, so the rest is never worked out: `figures` (tonnage, keyLifts'
 * stats and the e1RM points), `detail` (hard sets, RPE and, with a plan, exposures) and `records`
 * (the bests). A week left without a part has it empty (null, [] or 0). A rollup holds them all.
 */
export interface WeekParts {
	plan?: WeekPlan | null;
	figures?: boolean;
	detail?: boolean;
	records?: boolean;
}

/**
 * Each week of `mondays` (in order), from the counted sets of those weeks' days (the facts
 * loader's, in the order performed), with the parts asked for (all unless told otherwise) and,
 * for the exposures, `plan` (null: exposures left out). Throws as the strength functions do for an
 * exercise `exercises` does not hold.
 */
export function strengthWeeks(
	facts: readonly WeekFact[],
	exercises: ReadonlyMap<string, StrengthExercise>,
	timeZone: string,
	mondays: readonly IsoDate[],
	{ plan = null, figures = true, detail = true, records = true }: WeekParts = {}
): StrengthWeek[] {
	const live = facts.filter((set) => set.deletedAt === null);
	const none = new Map<IsoDate, never>();
	const tonnage = figures ? tonnageByWeek(live, exercises, timeZone) : none;
	const hardSets = detail ? hardSetsByWeek(live, exercises, timeZone) : none;
	const rpe = detail ? rpeByWeek(live, timeZone) : none;
	const days = live.map((set) => localDay(set.performedAt, timeZone));
	const weekOf = new Map<IsoDate, IsoDate>();
	const mondayOfDay = (day: IsoDate) => {
		let monday = weekOf.get(day);
		if (monday === undefined) weekOf.set(day, (monday = mondayOf(day)));
		return monday;
	};
	const setsOf = Map.groupBy(live.keys(), (i) => mondayOfDay(days[i]!));

	const weeks = new Map<IsoDate, StrengthWeek>();
	const lifts = new Map<IsoDate, Map<string, WeekLift>>();
	for (const weekStart of mondays) {
		const indexes = setsOf.get(weekStart) ?? [];
		const sets = indexes.map((i) => live[i]!);
		const byLift = new Map<string, WeekLift>();
		for (const set of sets) {
			if (byLift.has(set.exercise)) continue;
			byLift.set(set.exercise, {
				exercise: set.exercise,
				...{ workouts: [], last: 0, e1rm: false, rpes: [], sessions: [] }
			});
		}
		for (const [id, stats] of figures ? liftStats(sets, exercises) : []) {
			const lift = byLift.get(id)!;
			lift.workouts = [...stats.workouts];
			lift.last = stats.last;
			lift.e1rm = stats.e1rm;
		}
		const rpes: number[] = [];
		for (const set of detail ? sets : []) {
			if (!isWorking(set) || set.rpe === null) continue;
			rpes.push(set.rpe);
			byLift.get(set.exercise)!.rpes.push(set.rpe);
		}
		lifts.set(weekStart, byLift);
		weeks.set(weekStart, {
			weekStart,
			firstDay: indexes.length ? days[indexes[0]!]! : null,
			tonnage: tonnage.get(weekStart) ?? null,
			hardSets: hardSets.get(weekStart) ?? null,
			rpe: rpe.get(weekStart) ?? null,
			rpes,
			lifts: [...byLift.values()],
			exposures: detail && plan ? [] : null
		});
	}

	// Sessions over every week given, so a workout run past midnight on a Sunday stays one.
	const parts = { points: figures, bests: records };
	for (const [id, sets] of figures || records ? Map.groupBy(live, (set) => set.exercise) : []) {
		const sessions = Map.groupBy(strengthSessions(sets, exercises.get(id)!, timeZone, parts), (s) =>
			mondayOfDay(s.on)
		);
		for (const [weekStart, held] of sessions) {
			const lift = lifts.get(weekStart)?.get(id);
			if (lift) lift.sessions = improving(held);
		}
	}
	if (detail && plan)
		for (const e of exposuresOf(live, plan)) weeks.get(mondayOfDay(e.day))?.exposures!.push(e);
	return mondays.map((monday) => weeks.get(monday)!);
}

// ---- Stored form --------------------------------------------------------------------------------

/**
 * The version of what a rollup stores: a rollup of another version is summed again. Bump it in the
 * PR that changes any figure packWeek gives for the same facts, StrengthWeek's shape or a function
 * it reads outside analytics included (e1RM, records, load rules, hard sets, prescription
 * matching), or closed weeks keep the old figures beside new ones. strength-weeks.test.ts pins a
 * week's packed figures under each version to catch it.
 */
export const DIGEST_VERSION = 1;

/**
 * A week as a rollup stores it: StrengthWeek with its keys dropped and each workout id written
 * once, so two years read back small. Days are offsets from the Monday. Only a week whose workouts
 * are all its own is stored, so every day and workout a session names is the week's.
 */
export interface PackedWeek {
	/** The workout ids the week's lifts and sessions name, by index. */
	ids: string[];
	week: [
		firstDay: number | null,
		tonnage: number | null,
		hardSets: HardSetCount | null,
		rpe: number | null,
		rpes: number[]
	];
	lifts: PackedLift[];
	exposures: PackedExposure[] | null;
}

type PackedPoint = [
	value: number,
	method: E1rmPoint['method'],
	confidence: E1rmPoint['confidence'],
	setId: string
];
type PackedBest = [
	kind: SessionBest['kind'],
	reps: number | null,
	value: number,
	setId: string | null
];
type PackedSession = [
	workout: number,
	on: number,
	lastOn: number,
	point: PackedPoint | null,
	bests: PackedBest[]
];
type PackedLift = [
	exercise: string,
	workouts: number[],
	last: number,
	e1rm: boolean,
	rpes: number[],
	sessions: PackedSession[]
];
type PackedExposure = [
	day: number,
	exerciseId: string,
	substituted: boolean,
	rpeDeviations: number[],
	rpeTargets: number[]
];

/** `week` (one whose workouts are all its own) as a rollup stores it. */
export function packWeek(week: StrengthWeek): PackedWeek {
	const ids: string[] = [];
	const index = new Map<string, number>();
	const id = (workout: string) => {
		let i = index.get(workout);
		if (i === undefined) index.set(workout, (i = ids.push(workout) - 1));
		return i;
	};
	const day = (on: IsoDate) => daysBetween(week.weekStart, on);
	return {
		ids,
		week: [
			week.firstDay === null ? null : day(week.firstDay),
			week.tonnage,
			week.hardSets,
			week.rpe,
			week.rpes
		],
		lifts: week.lifts.map((lift) => [
			lift.exercise,
			lift.workouts.map(id),
			lift.last,
			lift.e1rm,
			lift.rpes,
			lift.sessions.map((s): PackedSession => [
				id(s.workoutId),
				day(s.on),
				day(s.lastOn),
				s.point && [s.point.value, s.point.method, s.point.confidence, s.point.setId],
				s.bests.map((b): PackedBest => [b.kind, b.reps, b.value, b.setId])
			])
		]),
		exposures:
			week.exposures &&
			week.exposures.map((e) => [
				day(e.day),
				e.exerciseId,
				e.substituted,
				e.rpeDeviations,
				e.rpeTargets
			])
	};
}

/** The week of `weekStart` a rollup stored (packWeek's), as strengthWeeks gives it. */
export function unpackWeek(
	weekStart: IsoDate,
	{ ids, week, lifts, exposures }: PackedWeek
): StrengthWeek {
	const days = Array.from({ length: 7 }, (_, n) => addDays(weekStart, n));
	const [firstDay, tonnage, hardSets, rpe, rpes] = week;
	return {
		weekStart,
		firstDay: firstDay === null ? null : days[firstDay]!,
		tonnage,
		hardSets,
		rpe,
		rpes,
		lifts: lifts.map(([exercise, workouts, last, e1rm, liftRpes, sessions]) => ({
			exercise,
			workouts: workouts.map((i) => ids[i]!),
			last,
			e1rm,
			rpes: liftRpes,
			sessions: sessions.map(([workout, on, lastOn, point, bests]) => {
				const workoutId = ids[workout]!;
				return {
					workoutId,
					on: days[on]!,
					lastOn: days[lastOn]!,
					point: point && {
						kind: 'estimated' as const,
						value: point[0],
						method: point[1],
						confidence: point[2],
						workoutId,
						on: days[on]!,
						setId: point[3]
					},
					bests: bests.map(([kind, reps, value, setId]) => ({ kind, reps, value, setId }))
				};
			})
		})),
		exposures:
			exposures &&
			exposures.map(([day, exerciseId, substituted, rpeDeviations, rpeTargets]) => ({
				day: days[day]!,
				exerciseId,
				substituted,
				rpeDeviations,
				rpeTargets
			}))
	};
}
