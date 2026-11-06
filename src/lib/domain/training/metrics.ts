/**
 * Training metrics (PRD §3, §9): the one definition of each number the generator, the history
 * queries, the screens and the coach (M4–M7) share. Every formula is M1's (e1rm.ts, load.ts,
 * units.ts), called and never redefined; this module decides only which sets count and how they
 * are grouped. src/lib/domain/README.md lists the inputs, outputs and caveats of each function.
 *
 * - Loads are compared and returned in kilograms, distances summed in metres, both through M1's
 *   exact conversion factors.
 * - Weeks run Monday to Sunday on the owner's calendar: an instant is first turned into the day
 *   the owner lived (localDay, in the profile's time zone), so a Sunday-evening session stays in
 *   its own week.
 * - The hard-set definition is a coaching judgement the owner has yet to confirm. It is isHardSet
 *   and the constants beside it, so changing it is an edit here, and nothing else counts sets.
 */
import { mondayOf } from '../calendar.ts';
import type { IsoDate } from '../calendar.ts';
import { localDay } from '../dates.ts';
import { estimateOneRepMax } from '../e1rm.ts';
import type { E1rmEstimate } from '../e1rm.ts';
import type { CatalogueExercise } from '../exercises/format.ts';
import { sessionLoad } from '../load.ts';
import { cleanFloat, convertWeight, fromMetres, toMetres } from '../units.ts';
import type { DistanceUnit, WeightUnit } from '../units.ts';
import type { ExerciseRef, SessionPlan, WeekPlan } from './types.ts';
import { MUSCLE_GROUP } from './vocabulary.ts';
import type { Muscle, MuscleGroup, SetRole } from './vocabulary.ts';

// ---- The hard-set definition ----------------------------------------------------------------

/**
 * A working set at or above this RPE is a hard set: three reps or fewer in reserve. So is a
 * working set with no RPE, which is taken as hard rather than dropped from the count.
 */
export const HARD_SET_MIN_RPE = 7;

/** What one hard set credits its exercise's primary and secondary muscles. */
export const HARD_SET_CREDIT = { primary: 1, secondary: 0.5 } as const;

/**
 * Planned roles that are not working sets. A ramp is the climb to the top set, so it counts as
 * warm-up, and M4 must log its sets as warm-ups for the plan and the log to count alike.
 */
export const NON_WORKING_ROLES: readonly SetRole[] = ['warm_up', 'ramp'];

/** The single definition of a hard set, for logged and planned sets alike. */
export function isHardSet(working: boolean, rpe: number | null): boolean {
	return working && (rpe === null || rpe >= HARD_SET_MIN_RPE);
}

/** The rep counts personalRecords keeps a heaviest load for: 1 to this. */
export const PR_MAX_REPS = 10;

// ---- Inputs ---------------------------------------------------------------------------------

/** A logged set as the metrics read it: an M4 set record, its weight in the unit entered. */
export interface LoggedSet {
	/** Any id the `exercises` lookup also uses; plans use exerciseRefKey's. */
	exercise: string;
	/** Null when the set carries no load (bodyweight, or measured in time or distance). */
	weight: number | null;
	unit: WeightUnit;
	/** Reps completed; null for a set measured in time or distance. */
	reps: number | null;
	rpe: number | null;
	isWarmup: boolean;
	isSkipped: boolean;
	performedAt: Date;
}

/** What setE1rm reads of a set. */
export type E1rmSet = Pick<
	LoggedSet,
	'weight' | 'unit' | 'reps' | 'rpe' | 'isWarmup' | 'isSkipped'
>;

/** What bestE1rm and personalRecords read of a set. */
export type DatedSet = E1rmSet & Pick<LoggedSet, 'performedAt'>;

/**
 * The muscles an exercise works, as a catalogue entry or a custom exercise names them. Both are
 * validated (parseTable, customExerciseSchema): no muscle is listed twice, or in both lists.
 */
export type ExerciseMuscles = Pick<CatalogueExercise, 'primaryMuscles' | 'secondaryMuscles'>;

/** A plan's exercise as the `exercises` lookups name it: its key, or `custom:<uuid>`. */
export function exerciseRefKey(ref: ExerciseRef): string {
	return 'key' in ref ? ref.key : `custom:${ref.customId}`;
}

/** The Monday of the week `instant` falls in on the owner's calendar. */
export function weekStartOf(instant: Date, timeZone: string): IsoDate {
	return mondayOf(localDay(instant, timeZone));
}

const isWorking = (set: E1rmSet) => !set.isWarmup && !set.isSkipped;

/** Ties go to the most recent set. */
const beats = (value: number, at: Date, held: number, heldAt: Date) =>
	value > held || (value === held && at.getTime() > heldAt.getTime());

// ---- Strength -------------------------------------------------------------------------------

/**
 * A set's estimated 1RM in kg: M1's estimateOneRepMax after converting the weight to kg. Null for
 * a warm-up, a skipped set, a set with no load or reps, and an RPE under 6 (M1's RPE_MIN).
 */
export function setE1rm(set: E1rmSet): E1rmEstimate | null {
	if (!isWorking(set) || set.weight === null || set.reps === null) return null;
	const weight = convertWeight(set.weight, set.unit, 'kg');
	return estimateOneRepMax({ weight, reps: set.reps, rpe: set.rpe });
}

export interface BestE1rm<S> extends E1rmEstimate {
	/** The set it was estimated from. */
	set: S;
}

/**
 * The highest setE1rm among one exercise's sets, in kg. Always an estimate, never a measured max,
 * even for a single at RPE 10. Null when no set gives an estimate.
 */
export function bestE1rm<S extends DatedSet>(sets: readonly S[]): BestE1rm<S> | null {
	let best: BestE1rm<S> | null = null;
	for (const set of sets) {
		const estimate = setE1rm(set);
		if (!estimate) continue;
		if (!best || beats(estimate.value, set.performedAt, best.value, best.set.performedAt))
			best = { ...estimate, set };
	}
	return best;
}

export interface RepRecord<S> {
	reps: number;
	weightKg: number;
	set: S;
}

/**
 * The heaviest load lifted for each rep count from 1 to PR_MAX_REPS among one exercise's working
 * sets, lightest rep count first. A rep count never lifted with a load is left out.
 */
export function personalRecords<S extends DatedSet>(sets: readonly S[]): RepRecord<S>[] {
	const records = new Map<number, RepRecord<S>>();
	for (const set of sets) {
		const { reps, weight } = set;
		if (!isWorking(set) || weight === null || !(weight > 0) || reps === null) continue;
		if (!Number.isInteger(reps) || reps < 1 || reps > PR_MAX_REPS) continue;
		const weightKg = convertWeight(weight, set.unit, 'kg');
		const held = records.get(reps);
		if (!held || beats(weightKg, set.performedAt, held.weightKg, held.set.performedAt))
			records.set(reps, { reps, weightKg, set });
	}
	return [...records.values()].sort((a, b) => a.reps - b.reps);
}

/** A Monday-to-Sunday week's hard sets per muscle and per muscle group. */
export interface WeekHardSets {
	/** The week's Monday. */
	weekStart: IsoDate;
	muscles: Partial<Record<Muscle, number>>;
	groups: Partial<Record<MuscleGroup, number>>;
}

function musclesOf(exercises: ReadonlyMap<string, ExerciseMuscles>, exercise: string) {
	const muscles = exercises.get(exercise);
	if (!muscles) throw new RangeError(`No muscles known for exercise '${exercise}'`);
	return muscles;
}

/**
 * Adds `count` hard sets of an exercise to a week: HARD_SET_CREDIT to each of its muscles, and to
 * each muscle group once, at its best credit, so a row working lats and upper back is one hard
 * set for the back.
 */
function credit(week: WeekHardSets, exercise: ExerciseMuscles, count: number) {
	const groups = new Map<MuscleGroup, number>();
	const worked = [
		[exercise.primaryMuscles, HARD_SET_CREDIT.primary],
		[exercise.secondaryMuscles, HARD_SET_CREDIT.secondary]
	] as const;
	for (const [muscles, value] of worked) {
		for (const muscle of muscles) {
			week.muscles[muscle] = (week.muscles[muscle] ?? 0) + value * count;
			const group = MUSCLE_GROUP[muscle];
			groups.set(group, Math.max(groups.get(group) ?? 0, value));
		}
	}
	for (const [group, value] of groups)
		week.groups[group] = (week.groups[group] ?? 0) + value * count;
}

const emptyWeek = (weekStart: IsoDate): WeekHardSets => ({ weekStart, muscles: {}, groups: {} });

/**
 * Logged hard sets per week (isHardSet), oldest week first; weeks with none are left out.
 * `exercises` gives every set's exercise its muscles. A set whose exercise it lacks throws, hard
 * or not, so a missing lookup is caught whatever the sets' RPEs.
 */
export function hardSets(
	sets: readonly LoggedSet[],
	exercises: ReadonlyMap<string, ExerciseMuscles>,
	timeZone: string
): WeekHardSets[] {
	const weeks = new Map<IsoDate, WeekHardSets>();
	for (const set of sets) {
		const muscles = musclesOf(exercises, set.exercise);
		if (!isHardSet(isWorking(set), set.rpe)) continue;
		const weekStart = weekStartOf(set.performedAt, timeZone);
		const week = weeks.get(weekStart) ?? emptyWeek(weekStart);
		weeks.set(weekStart, week);
		credit(week, muscles, 1);
	}
	return [...weeks.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

/**
 * A planned week's hard sets, counted as hardSets counts the same sets once logged: each
 * prescription line credits its `sets` when isHardSet holds for its role and target RPE. Runs and
 * other sessions credit none, a strength class included: the class sets its own content.
 */
export function plannedHardSets(
	week: WeekPlan,
	exercises: ReadonlyMap<string, ExerciseMuscles>
): WeekHardSets {
	const tally = emptyWeek(week.startsOn);
	for (const session of week.sessions) {
		if (session.kind !== 'strength') continue;
		for (const planned of session.exercises) {
			const muscles = musclesOf(exercises, exerciseRefKey(planned.exercise));
			for (const line of planned.sets) {
				if (isHardSet(!NON_WORKING_ROLES.includes(line.role), line.targetRpe))
					credit(tally, muscles, line.sets);
			}
		}
	}
	return tally;
}

// ---- Any discipline -------------------------------------------------------------------------

/** What sessionLoadOf reads of a logged workout (M4's workouts row); either may be unknown. */
export interface LoggedSessionLoad {
	durationSeconds: number | null;
	sessionRpe: number | null;
}

/**
 * A session's load in AU through M1's sessionLoad(minutes, RPE): a planned session from its
 * estimated minutes and target RPE, a logged one from its duration and session RPE (null until
 * both are recorded).
 */
export function sessionLoadOf(session: Pick<SessionPlan, 'estMinutes' | 'targetRpe'>): number;
export function sessionLoadOf(session: LoggedSessionLoad): number | null;
export function sessionLoadOf(
	session: Pick<SessionPlan, 'estMinutes' | 'targetRpe'> | LoggedSessionLoad
): number | null {
	if ('estMinutes' in session) return sessionLoad(session.estMinutes, session.targetRpe);
	const { durationSeconds, sessionRpe } = session;
	if (durationSeconds === null || sessionRpe === null) return null;
	return sessionLoad(durationSeconds / 60, sessionRpe);
}

/** A logged run's distance as entered, and when it started. */
export interface LoggedDistance {
	distance: number;
	unit: DistanceUnit;
	startedAt: Date;
}

export interface WeekDistance {
	/** The week's Monday. */
	weekStart: IsoDate;
	/** Exact, through M1's toMetres, with floating-point noise removed (cleanFloat). */
	metres: number;
	/** The same total in the unit asked for, through M1's fromMetres, also free of noise. */
	distance: number;
}

/** Running distance per week, oldest week first; weeks with no run are left out. */
export function weeklyDistance(
	runs: readonly LoggedDistance[],
	unit: Exclude<DistanceUnit, 'm'>,
	timeZone: string
): WeekDistance[] {
	const metres = new Map<IsoDate, number>();
	for (const run of runs) {
		const weekStart = weekStartOf(run.startedAt, timeZone);
		metres.set(weekStart, (metres.get(weekStart) ?? 0) + toMetres(run.distance, run.unit));
	}
	return [...metres]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([weekStart, total]) => {
			const exact = cleanFloat(total);
			return { weekStart, metres: exact, distance: cleanFloat(fromMetres(exact, unit)) };
		});
}
