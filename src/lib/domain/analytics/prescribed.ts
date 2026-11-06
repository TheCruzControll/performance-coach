/**
 * Prescribed against actual (PRD §5, §10): every logged set paired with the prescription line it
 * was logged against, so actual-versus-target RPE, missed reps, completion and 'consistently
 * below target' are computed once, for the dashboards, the reviews and the progression rules.
 *
 * - Sets pair with lines by M4's slot numbering (pairBySetIndex in domain/workout/selectors.ts),
 *   never a second rule: a planned exercise's lines give its sets in order, set i is the i-th,
 *   and the first set logged at index i takes it.
 * - Warm-up and ramp lines (M3's NON_WORKING_ROLES) take warm-up sets; every other line, a role
 *   this code does not know included, takes working sets. A set of the other kind at a line's
 *   index leaves the line missing and is itself extra. A skip has no kind (M4's set.skip carries
 *   none), so it takes the line at its index either way.
 * - A set the device marked extra never takes a line, as M4's progress never counts one.
 * - A substitute's sets fill the slots they were logged at but compare against nothing.
 * - A deviation is actual minus target RPE (positive: harder than prescribed), null when either
 *   is missing, never 0.
 *
 * Conventions for src/lib/domain/analytics (M6): pure (no I/O, clock or randomness), imported by
 * path (no index file), no zod, no runtime import of domain/programming or domain/exercises.
 * Server-only at runtime: this is not in scripts/analytics-client-imports.test.ts's CLIENT_SAFE.
 */
import { mondayOf } from '../calendar.ts';
import type { IsoDate } from '../calendar.ts';
import { prescribedLoad } from '../training/describe.ts';
import { NON_WORKING_ROLES } from '../training/metrics.ts';
import type { SetPrescription } from '../training/types.ts';
import type { PlanStatus, SetRole } from '../training/vocabulary.ts';
import { cleanFloat, convertWeight } from '../units.ts';
import type { WeightUnit } from '../units.ts';
import { topSetOf } from '../workout/prefill.ts';
import type { CanonicalSet } from '../workout/protocol.ts';
import { pairBySetIndex } from '../workout/selectors.ts';
import type { Paired } from '../workout/selectors.ts';
import type { LoggedSet } from '../workout/types.ts';
import { mean } from './series.ts';

// ---- Coaching judgements the owner can change here -------------------------------------------

/**
 * 'Consistently' below or above target: a mean deviation of at least `rpe` (1.0) either way in
 * `agree` (2) of the last `window` (3) exposures of a lift. The progression rules read it.
 */
export const CONSISTENCY = { window: 3, rpe: 1, agree: 2 } as const;

/** A set within ±0.5 of its target RPE counts as on target. */
export const RPE_WITHIN = 0.5;

/** A completed workout that did this share of its prescribed working sets is completed, else partial. */
export const COMPLETED_SHARE = 0.8;

// ---- Matching --------------------------------------------------------------------------------

/**
 * A logged set as the facts carry it (CanonicalSet fits): the weight in the unit entered, the
 * planned exercise's lineage (null off plan) and its 1-based index in the slot.
 */
export type ActualSet = LoggedSet &
	Pick<CanonicalSet, 'plannedLineage' | 'exerciseId' | 'setIndex' | 'isSkipped'>;

/** A planned exercise: the version's lines in order, and the exercise they prescribe. */
export interface PlannedLines {
	lineage: string;
	exerciseId: string;
	lines: readonly SetPrescription[];
}

export interface MatchContext {
	/** The owner's weight unit, which every prescribed load was shown in. */
	unit: WeightUnit;
	/** The e1RM in kg a from_e1rm line was a fraction of; without it, its load is not fixed. */
	e1rmKg?: (line: SetPrescription) => number | null;
}

/** What one planned set asks for. */
export interface Target {
	/** 1-based: which of the exercise's lines. */
	line: number;
	role: SetRole;
	warmUp: boolean;
	repsMin: number | null;
	repsMax: number | null;
	seconds: number | null;
	metres: number | null;
	rpe: number | null;
	/** The load in kg, where the line fixes one (M3's prescribedLoad); null for RPE-picked loads. */
	kg: number | null;
}

/** done, skipped (set.skip), missing (nothing logged at its index), or extra (no line). */
export type MatchStatus = 'done' | 'skipped' | 'missing' | 'extra';

export interface SetMatch {
	setIndex: number;
	status: MatchStatus;
	/** The line's set; null for an extra set. */
	target: Target | null;
	actual: ActualSet | null;
	/** Logged for another exercise than the line's: it fills the slot and compares against nothing. */
	substitute: boolean;
	rpeDeviation: number | null;
	/** Reps under the line's lower bound, 0 at or over it; null off a reps line or uncompared. */
	repsShort: number | null;
	/** Whether the line's amount was reached: its lower rep bound, seconds or metres. */
	hit: boolean | null;
}

export interface PrescriptionMatch {
	lineage: string;
	exerciseId: string;
	/** By set index; at one index, the line's set before any extra one. */
	sets: SetMatch[];
}

const UNCOMPARED = { rpeDeviation: null, repsShort: null, hit: null } as const;

const kgOf = (set: LoggedSet) =>
	set.weight === null ? null : convertWeight(set.weight, set.unit, 'kg');

function targetOf(line: SetPrescription, n: number, context: MatchContext): Target {
	const oneRepMaxKg = line.loadKind === 'from_e1rm' ? (context.e1rmKg?.(line) ?? null) : null;
	const load = prescribedLoad(line, { unit: context.unit, oneRepMaxKg });
	return {
		line: n,
		role: line.role,
		warmUp: NON_WORKING_ROLES.includes(line.role),
		repsMin: line.repsMin,
		repsMax: line.repsMax,
		seconds: line.seconds,
		metres: line.metres,
		rpe: line.targetRpe,
		kg: load === null ? null : convertWeight(load, context.unit, 'kg')
	};
}

function compare(target: Target, actual: ActualSet) {
	const reps = target.repsMin ?? target.repsMax;
	const [want, got] =
		reps !== null
			? [reps, actual.reps]
			: target.seconds !== null
				? [target.seconds, actual.seconds]
				: [target.metres, actual.metres];
	return {
		rpeDeviation:
			target.rpe === null || actual.rpe === null ? null : cleanFloat(actual.rpe - target.rpe),
		repsShort: reps === null || actual.reps === null ? null : Math.max(0, reps - actual.reps),
		hit: want === null || got === null ? null : got >= want
	};
}

function matchOf(
	setIndex: number,
	target: Target | null,
	actual: ActualSet | null,
	exerciseId: string
): SetMatch {
	const substitute = actual !== null && actual.exerciseId !== exerciseId;
	const base = { setIndex, target, actual, substitute, ...UNCOMPARED };
	if (target === null) return { ...base, status: 'extra' };
	if (actual === null) return { ...base, status: 'missing' };
	if (actual.isSkipped) return { ...base, status: 'skipped' };
	return { ...base, status: 'done', ...(substitute ? UNCOMPARED : compare(target, actual)) };
}

/**
 * One planned exercise's lines against a workout's sets: those logged against its lineage, in
 * M4's canonical order (setIndex, performedAt, id), as the projection and the facts give them.
 */
export function matchPrescription(
	planned: PlannedLines,
	sets: readonly ActualSet[],
	context: MatchContext
): PrescriptionMatch {
	const slots = planned.lines.flatMap((line, i) => {
		const target = targetOf(line, i + 1, context);
		return Array.from({ length: line.sets }, () => target);
	});
	const own = sets.filter((set) => set.plannedLineage === planned.lineage);
	const marked: Paired<Target, ActualSet>[] = own
		.filter((set) => set.isExtra)
		.map((set) => ({ setIndex: set.setIndex, planned: null, logged: set }));
	const rows = [
		...pairBySetIndex(
			slots,
			own.filter((set) => !set.isExtra)
		),
		...marked
	];
	const id = planned.exerciseId;
	const matches = rows.flatMap(({ setIndex, planned: target, logged }) =>
		target && logged && !logged.isSkipped && target.warmUp !== logged.isWarmup
			? [matchOf(setIndex, target, null, id), matchOf(setIndex, null, logged, id)]
			: [matchOf(setIndex, target, logged, id)]
	);
	return {
		lineage: planned.lineage,
		exerciseId: planned.exerciseId,
		sets: matches.sort((a, b) => a.setIndex - b.setIndex)
	};
}

// ---- Exposures -------------------------------------------------------------------------------

type Slot = SetMatch & { target: Target };
type Done = Slot & { actual: ActualSet };

const isWorkingSlot = (m: SetMatch): m is Slot => m.target !== null && !m.target.warmUp;
const isDone = (m: Slot): m is Done => m.status === 'done';

/** One planned exercise in one workout: what the progression rules and the reviews compare. */
export interface Exposure {
	day: IsoDate;
	lineage: string;
	exerciseId: string;
	/** Its working sets were all another exercise's: nothing here compares. */
	substituted: boolean;
	/** Working sets only: the lines' (prescribed), those done, and extra ones done. */
	sets: { prescribed: number; completed: number; extra: number };
	/** Per working set, the larger of the reps logged as missed and the reps short of the line. */
	missedReps: number;
	/** Each working set's deviation, where both RPEs exist, by set index. */
	rpeDeviations: number[];
	meanRpeDeviation: number | null;
	/** The first top-set line's set, whatever became of it; else the heaviest working set done. */
	topSet: SetMatch | null;
	/** The top set's load in kg, when it was done with one. */
	kg: number | null;
	/** Every prescribed working set done and its amount reached; null when nothing compares. */
	hit: boolean | null;
}

/** A match summed up; `day` is the workout's, on the owner's calendar. */
export function exposure(match: PrescriptionMatch, day: IsoDate): Exposure {
	const slots = match.sets.filter(isWorkingSlot);
	const done = slots.filter(isDone);
	const own = done.filter((m) => !m.substitute);
	const deviations = own.flatMap((m) => (m.rpeDeviation === null ? [] : [m.rpeDeviation]));
	const hits = own.flatMap((m) => (m.hit === null ? [] : [m.hit]));
	const substituted = done.length > 0 && own.length === 0;
	// The server stores no assistance, so every load reads as weight: M4's rule for 'external'.
	const heaviest = topSetOf(
		own.map((m) => m.actual),
		'external'
	);
	const topSet =
		slots.find((m) => m.target.role === 'top' && !m.substitute) ??
		own.find((m) => m.actual === heaviest) ??
		null;
	const extra = match.sets.filter(
		(m) => m.status === 'extra' && !m.actual?.isWarmup && !m.actual?.isSkipped
	).length;
	return {
		day,
		lineage: match.lineage,
		exerciseId: match.exerciseId,
		substituted,
		sets: { prescribed: slots.length, completed: done.length, extra },
		missedReps: own.reduce((sum, m) => sum + Math.max(m.actual.missedReps, m.repsShort ?? 0), 0),
		rpeDeviations: deviations,
		meanRpeDeviation: mean(deviations),
		topSet,
		kg: topSet?.status === 'done' && topSet.actual ? kgOf(topSet.actual) : null,
		hit:
			substituted || slots.length === 0
				? null
				: done.length < slots.length
					? false
					: hits.length === 0
						? null
						: hits.every(Boolean)
	};
}

const byDay = <T extends { day: IsoDate }>(list: readonly T[]) =>
	[...list].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

export type ConsistencyVerdict = 'below' | 'above' | 'within' | 'too_few';

export interface Consistency {
	verdict: ConsistencyVerdict;
	/** The exposures read: the lift's own last `window`, oldest first. */
	exposures: Exposure[];
	/** Those of them with missed reps. */
	missed: Exposure[];
}

/**
 * Whether a lift has been consistently easier (below) or harder (above) than prescribed. Reads
 * the last `window` exposures by day, a substitute's left out; too few until CONSISTENCY.agree
 * of them have a deviation.
 */
export function consistency(
	exposures: readonly Exposure[],
	window: number = CONSISTENCY.window
): Consistency {
	if (!Number.isInteger(window) || window < 1) {
		throw new RangeError(`A window is a positive whole number: ${window}`);
	}
	const last = byDay(exposures.filter((e) => !e.substituted)).slice(-window);
	const means = last.flatMap((e) => (e.meanRpeDeviation === null ? [] : [e.meanRpeDeviation]));
	const agree = (side: (d: number) => boolean) => means.filter(side).length >= CONSISTENCY.agree;
	const verdict: ConsistencyVerdict =
		means.length < CONSISTENCY.agree
			? 'too_few'
			: agree((d) => d <= -CONSISTENCY.rpe)
				? 'below'
				: agree((d) => d >= CONSISTENCY.rpe)
					? 'above'
					: 'within';
	return { verdict, exposures: last, missed: last.filter((e) => e.missedReps > 0) };
}

// ---- Summaries -------------------------------------------------------------------------------

export interface DeviationSummary {
	count: number;
	mean: number | null;
	meanAbsolute: number | null;
	/** How many, and what share, were within RPE_WITHIN of target. */
	within: number;
	withinShare: number | null;
}

export interface RpeDeviationSummary {
	overall: DeviationSummary;
	/** By the planned exercise. */
	byExercise: Record<string, DeviationSummary>;
	/** By Monday, oldest first. */
	byWeek: Record<IsoDate, DeviationSummary>;
}

function summarise(deviations: readonly number[]): DeviationSummary {
	const within = deviations.filter((d) => Math.abs(d) <= RPE_WITHIN).length;
	return {
		count: deviations.length,
		mean: mean(deviations),
		meanAbsolute: mean(deviations.map(Math.abs)),
		within,
		withinShare: deviations.length === 0 ? null : cleanFloat(within / deviations.length)
	};
}

/** Actual against target RPE over working sets, a substitute's exposures left out. */
export function rpeDeviationSummary(exposures: readonly Exposure[]): RpeDeviationSummary {
	const own = byDay(exposures.filter((e) => !e.substituted));
	const by = (key: (e: Exposure) => string) => {
		const groups = new Map<string, number[]>();
		for (const e of own) groups.set(key(e), [...(groups.get(key(e)) ?? []), ...e.rpeDeviations]);
		return Object.fromEntries([...groups].map(([k, deviations]) => [k, summarise(deviations)]));
	};
	return {
		overall: summarise(own.flatMap((e) => e.rpeDeviations)),
		byExercise: by((e) => e.exerciseId),
		byWeek: by((e) => mondayOf(e.day))
	};
}

export type CompletionStatus = 'completed' | 'partial' | 'skipped' | 'missed' | 'pending';

export interface SessionCompletion {
	status: CompletionStatus;
	/** Working sets across the workout's planned exercises; 0 for a session without lines. */
	prescribed: number;
	completed: number;
}

/**
 * A planned session's outcome. `workout` is a match for every planned exercise of its completed
 * workout, or null with none: a completed workout wins over a stored skip, as M3's program reads
 * derive 'completed'. Without one, a session is skipped by choice, missed once its day has
 * passed, and pending until then.
 */
export function sessionCompletion(
	session: { date: IsoDate; status: PlanStatus },
	workout: readonly PrescriptionMatch[] | null,
	today: IsoDate
): SessionCompletion {
	if (workout === null) {
		const status =
			session.status === 'skipped' ? 'skipped' : session.date < today ? 'missed' : 'pending';
		return { status, prescribed: 0, completed: 0 };
	}
	const slots = workout.flatMap((m) => m.sets).filter(isWorkingSlot);
	const completed = slots.filter(isDone).length;
	const share = slots.length === 0 ? 1 : completed / slots.length;
	return {
		status: share >= COMPLETED_SHARE ? 'completed' : 'partial',
		prescribed: slots.length,
		completed
	};
}
