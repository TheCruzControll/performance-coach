/**
 * Strength analytics (PRD §10): e1RM trends, top-set progression, PRs with their dates, weekly
 * tonnage and hard sets, sets per muscle group against a target range, and average RPE. Every
 * strength figure on Progress, in the reviews and in the coach's tools is one of these.
 *
 * - Nothing here is a new formula. Which sets count and what they count toward are M4's logging
 *   rules (logging.ts: isWorking, e1rmOf, volumeOf, prKinds, prCandidates); the numbers are M3's
 *   (bestE1rm, personalRecords, hardSets, isHardSet, weekStartOf) over M1's (estimateOneRepMax,
 *   volumeLoad, convertWeight).
 * - Loads are kilograms, converted from the unit entered through M1's exact factor.
 * - An e1RM is always an estimate, with its method and confidence. A measured 1RM comes only from
 *   the owner's profile (measuredMaxes) and is never merged into an e1RM series.
 * - A PR beats the record before it strictly, beyond floating-point noise, as M4's finish summary
 *   counts it: a tie is never a PR, and a record's first value (the exercise's first session, a
 *   rep count first lifted) is its baseline, not a PR.
 * - A session is one workout's sets of the exercise, on the owner's calendar day it started.
 * - Weekly figures are M3's Monday-to-Sunday weeks. The week in progress comes last, flagged
 *   inProgress, and never counts in a total (series.ts).
 * - Facts are completed, undeleted workouts' sets (the facts loader's rule); a set that still
 *   carries a deletion is dropped here too.
 *
 * Conventions for src/lib/domain/analytics (M6): pure (no I/O, clock or randomness), imported by
 * path (no index file), no zod, no runtime import of domain/programming or domain/exercises.
 * Server-only at runtime: this is not in scripts/analytics-client-imports.test.ts's CLIENT_SAFE.
 */
import type { IsoDate } from '../calendar.ts';
import { localDay } from '../dates.ts';
import type { E1rmEstimate } from '../e1rm.ts';
import type { StrengthBaseline } from '../profile/types.ts';
import {
	bestE1rm,
	hardSets,
	isHardSet,
	personalRecords,
	weekStartIn
} from '../training/metrics.ts';
import type { ExerciseMuscles, LoggedSet as MetricsSet } from '../training/metrics.ts';
import type { BaselineLift } from '../training/types.ts';
import { MUSCLE_GROUPS } from '../training/vocabulary.ts';
import type { Muscle, MuscleGroup } from '../training/vocabulary.ts';
import { cleanFloat, convertWeight } from '../units.ts';
import {
	e1rmApplies,
	isWorking,
	PR_KIND_LABEL,
	prCandidates,
	volumeOf
} from '../workout/logging.ts';
import type { PrKind, RuledExercise } from '../workout/logging.ts';
import { above } from '../workout/summary.ts';
import { topSetOf } from '../workout/prefill.ts';
import type { LoggedSet as WorkoutSet } from '../workout/types.ts';
import type { Weeks } from './adherence.ts';
import { weekStarts } from './periods.ts';
import { byWeek, fillWeeks, mean } from './series.ts';
import type { Timed } from './series.ts';
import type { SeriesPoint } from './types.ts';

// ---- Choices the owner can change here --------------------------------------------------------

/** The most key lifts Progress follows: the profile's lifts first, then the most trained. */
export const KEY_LIFTS_MAX = 6;

/** How a 1RM from the profile reads beside an e1RM series. */
export const BASELINE_LABEL: Readonly<Record<StrengthBaseline['kind'], string>> = {
	measured: 'Measured',
	estimated: 'Estimated · from your profile'
};

/** M4's PRs, and the session-volume PR the history adds. */
export const STRENGTH_PR_LABEL = { ...PR_KIND_LABEL, volume: 'Session volume' } as const;
export type StrengthPrKind = PrKind | 'volume';

// ---- Inputs -----------------------------------------------------------------------------------

/**
 * A logged set as the facts carry it: M3's LoggedSet (the weight in the unit entered) with the
 * fields M4's rules read, its row and workout ids, the planned exercise's lineage (null off plan)
 * and its 1-based index in the slot. `deletedAt` is null for every set the facts loader gives.
 */
export interface StrengthFact
	extends
		MetricsSet,
		Pick<WorkoutSet, 'seconds' | 'metres' | 'assistance' | 'missedReps' | 'isExtra'> {
	id: string;
	workoutId: string;
	plannedLineage: string | null;
	setIndex: number;
	deletedAt: Date | null;
}

/**
 * What these functions read of an exercise: M4's measure and load type, M3's muscles and the
 * profile lift it stands for (a catalogue entry fits; a custom exercise has none).
 */
export type StrengthExercise = RuledExercise &
	ExerciseMuscles & { baselineLift: BaselineLift | null };

// ---- Sessions ---------------------------------------------------------------------------------

interface Session {
	workoutId: string;
	/** Its first set's instant and the owner's calendar day of it. */
	at: Date;
	on: IsoDate;
	sets: StrengthFact[];
}

/** The facts without a deletion: the same list when none has one, as the facts loader's never do. */
const live = (facts: readonly StrengthFact[]) =>
	facts.some((set) => set.deletedAt !== null)
		? facts.filter((set) => set.deletedAt === null)
		: facts;

function lookup<E>(exercises: ReadonlyMap<string, E>, exercise: string): E {
	const found = exercises.get(exercise);
	if (!found) throw new RangeError(`No exercise known for '${exercise}'`);
	return found;
}

/** One exercise's live sets by workout, oldest session first. Throws for two exercises' sets. */
function sessionsOf(facts: readonly StrengthFact[], timeZone: string): Session[] {
	const names = new Set(facts.map((set) => set.exercise));
	if (names.size > 1) throw new RangeError(`One exercise's sets only: ${[...names].join(', ')}`);
	const byWorkout = new Map<string, StrengthFact[]>();
	for (const set of live(facts)) {
		const sets = byWorkout.get(set.workoutId);
		if (sets) sets.push(set);
		else byWorkout.set(set.workoutId, [set]);
	}
	return [...byWorkout]
		.map(([workoutId, sets]) => {
			let first = sets[0]!.performedAt;
			for (const set of sets)
				if (set.performedAt.getTime() < first.getTime()) first = set.performedAt;
			const at = new Date(first.getTime());
			return { workoutId, at, on: localDay(at, timeZone), sets };
		})
		.sort((a, b) => a.at.getTime() - b.at.getTime() || a.workoutId.localeCompare(b.workoutId));
}

const kgOf = (set: StrengthFact) =>
	set.weight === null ? null : convertWeight(set.weight, set.unit, 'kg');

// ---- e1RM and measured maxes ------------------------------------------------------------------

/** A session's best e1RM in kg: always an estimate, with M1's method and confidence. */
export interface E1rmPoint extends E1rmEstimate {
	workoutId: string;
	on: IsoDate;
	/** The set it was estimated from. */
	setId: string;
}

/**
 * One point per session of one exercise: M3's bestE1rm of the sets M4's rules give an e1RM
 * (e1rmApplies). A session with none, a bodyweight or a timed exercise's, has no point.
 */
export function e1rmSeries(
	facts: readonly StrengthFact[],
	exercise: RuledExercise,
	timeZone: string
): E1rmPoint[] {
	return sessionsOf(facts, timeZone).flatMap(({ workoutId, on, sets }) => {
		const best = bestE1rm(sets.filter((set) => e1rmApplies(set, exercise)));
		if (!best) return [];
		const { kind, value, method, confidence, set } = best;
		return [{ kind, value, method, confidence, workoutId, on, setId: set.id }];
	});
}

/** A 1RM from the owner's profile, in kg, kept apart from the e1RM series. */
export interface MaxPoint extends Pick<
	StrengthBaseline,
	'id' | 'lift' | 'customLabel' | 'kind' | 'source' | 'method' | 'confidence'
> {
	/** The day it was achieved; null when the profile gives none. */
	on: IsoDate | null;
	kg: number;
	/** BASELINE_LABEL: 'Measured', or 'Estimated · from your profile'. */
	label: string;
}

/**
 * The profile's 1RMs (M2's baselines), in their order: a tested or competition max as measured,
 * an estimate (from a set, or the owner's guess) as 'Estimated · from your profile'. Their kind is
 * the one M2 derived from the source, so an estimate never reads as measured.
 */
export function measuredMaxes(baselines: readonly StrengthBaseline[]): MaxPoint[] {
	return baselines.map(({ id, lift, customLabel, kind, source, method, confidence, ...b }) => ({
		id,
		lift,
		customLabel,
		kind,
		source,
		method,
		confidence,
		on: b.achievedOn,
		kg: convertWeight(b.value, b.unit, 'kg'),
		label: BASELINE_LABEL[kind]
	}));
}

// ---- Top sets ---------------------------------------------------------------------------------

export interface TopSet {
	workoutId: string;
	on: IsoDate;
	/** M4's topSetOf among the session's working sets: the most load, then the most reps. */
	set: StrengthFact;
	/** Its load in kg; null for a set without a weight (an assisted or unloaded one). */
	kg: number | null;
	reps: number | null;
	/**
	 * The load used for the most working sets (ties to the heavier) and the most reps done in one
	 * set at it, for rep progression at a steady load; null when no working set has a weight.
	 */
	workingLoad: { kg: number; sets: number; reps: number | null } | null;
}

function workingLoadOf(working: readonly StrengthFact[]): TopSet['workingLoad'] {
	const loads = new Map<number, { kg: number; sets: number; reps: number | null }>();
	for (const set of working) {
		const kg = kgOf(set);
		if (kg === null) continue;
		const key = cleanFloat(kg);
		const held = loads.get(key) ?? { kg: key, sets: 0, reps: null };
		const reps = set.reps === null ? held.reps : Math.max(held.reps ?? 0, set.reps);
		loads.set(key, { kg: key, sets: held.sets + 1, reps });
	}
	let most: TopSet['workingLoad'] = null;
	for (const load of loads.values()) {
		if (!most || load.sets > most.sets || (load.sets === most.sets && load.kg > most.kg))
			most = load;
	}
	return most;
}

/** Each session's top set of one exercise, oldest first; a session with no working set has none. */
export function topSets(
	facts: readonly StrengthFact[],
	exercise: RuledExercise,
	timeZone: string
): TopSet[] {
	return sessionsOf(facts, timeZone).flatMap(({ workoutId, on, sets }) => {
		const working = sets.filter(isWorking);
		const top = topSetOf(working, exercise.loadType);
		if (!top) return [];
		const kg = kgOf(top);
		return [
			{
				workoutId,
				on,
				set: top,
				kg: kg === null ? null : cleanFloat(kg),
				reps: top.reps,
				workingLoad: workingLoadOf(working)
			}
		];
	});
}

// ---- PRs --------------------------------------------------------------------------------------

/** A record as it stood: its value (kg, or reps for 'Most reps') and where it was set. */
export interface HeldRecord {
	value: number;
	on: IsoDate;
	workoutId: string;
}

export interface StrengthPr {
	kind: StrengthPrKind;
	/** STRENGTH_PR_LABEL's. */
	label: string;
	workoutId: string;
	on: IsoDate;
	/** The set that broke it; null for a session-volume PR, which is the session's. */
	setId: string | null;
	/** A rep max's rep count; null for the others. */
	reps: number | null;
	/** The new record, in kg (reps for 'Most reps'). */
	value: number;
	/** The record it beat. */
	previous: HeldRecord;
	/** True for an e1RM, which is an estimate and never a measured max. */
	estimated: boolean;
}

/** One kind's best in a session, from the set that made it (none for volume). */
interface Best {
	kind: StrengthPrKind;
	reps: number | null;
	value: number;
	setId: string | null;
}

/**
 * A session's bests by M4's rules: each kind from the sets that compete for it (prCandidates),
 * through M3's bestE1rm and personalRecords, in prKinds' order, then the session's volume load
 * (volumeOf) when it is above 0.
 */
function sessionBests(sets: readonly StrengthFact[], exercise: RuledExercise): Best[] {
	// Each set's candidates are worked out once, then read for each kind.
	const candidates = sets.map((set) => prCandidates(set, exercise));
	const competing = (kind: PrKind) => sets.filter((_, i) => candidates[i]!.includes(kind));
	const bests: Best[] = [];
	const e1rm = bestE1rm(competing('e1rm'));
	if (e1rm) bests.push({ kind: 'e1rm', reps: null, value: e1rm.value, setId: e1rm.set.id });
	for (const { reps, weightKg, set } of personalRecords(competing('rep_max')))
		bests.push({ kind: 'rep_max', reps, value: weightKg, setId: set.id });
	let most: StrengthFact | null = null;
	for (const set of competing('most_reps'))
		if (!most || (set.reps ?? 0) >= (most.reps ?? 0)) most = set;
	if (most) bests.push({ kind: 'most_reps', reps: null, value: most.reps ?? 0, setId: most.id });
	const volume = sets.reduce((sum, set) => sum + (volumeOf(set, exercise) ?? 0), 0);
	if (volume > 0) bests.push({ kind: 'volume', reps: null, value: volume, setId: null });
	return bests;
}

/**
 * Every record one exercise broke, oldest first, each with the record it beat: e1RM, rep maxes
 * at 1 to 10 reps (M3's PR_MAX_REPS) and most reps, as M4's prKinds allow for the exercise, and
 * the session's volume load. A PR is strictly above the record before it (M4's `above`).
 *
 * Baseline rule (owner decision, M4 parity): a record's first value is its baseline, never a PR.
 * That holds per rep count too: a rep count first lifted is a baseline, as in M4's finish summary
 * (summary.ts beaten(): a kind with no prior best sets none), so 5×100 then 6×100 sets an e1RM PR
 * and a volume PR, not a 6-rep PR. To count a new rep count as a PR instead, change the `!previous`
 * skip below and summary.ts beaten() together; the agreement test pins the two.
 */
export function prTimeline(
	facts: readonly StrengthFact[],
	exercise: RuledExercise,
	timeZone: string
): StrengthPr[] {
	const records = new Map<string, HeldRecord>();
	const prs: StrengthPr[] = [];
	for (const { workoutId, on, sets } of sessionsOf(facts, timeZone)) {
		for (const { kind, reps, value, setId } of sessionBests(sets, exercise)) {
			const key = `${kind}:${reps ?? ''}`;
			const previous = records.get(key);
			if (previous && !above(value, previous.value)) continue;
			records.set(key, { value, on, workoutId });
			if (!previous) continue;
			const label = STRENGTH_PR_LABEL[kind];
			const estimated = kind === 'e1rm';
			prs.push({ kind, label, workoutId, on, setId, reps, value, previous, estimated });
		}
	}
	return prs;
}

// ---- Weekly volume ----------------------------------------------------------------------------

/**
 * Tonnage per week in kg: M4's volumeOf (M1's volumeLoad of the working reps sets that carry a
 * counted load) summed by M3's week, each complete week of `window` (0 with nothing lifted), then
 * the week in progress, flagged.
 */
export function weeklyTonnage(
	facts: readonly StrengthFact[],
	exercises: ReadonlyMap<string, RuledExercise>,
	timeZone: string,
	window: Weeks
): SeriesPoint[] {
	const lifted: Timed[] = [];
	for (const set of live(facts)) {
		const kg = volumeOf(set, lookup(exercises, set.exercise));
		if (kg !== null) lifted.push({ at: set.performedAt, value: kg });
	}
	return fillWeeks(byWeek(lifted, timeZone), window.weeks, 'zero', window.inProgress);
}

/** A week's hard sets: how many (M3's isHardSet), and M3's credit per muscle and group. */
export interface HardSetWeek {
	weekStart: IsoDate;
	inProgress: boolean;
	sets: number;
	muscles: Partial<Record<Muscle, number>>;
	groups: Partial<Record<MuscleGroup, number>>;
}

/**
 * Hard sets per week through M3's hardSets: 1.0 to each primary muscle and 0.5 to each secondary
 * one (HARD_SET_CREDIT), and each group once, at its best credit. Each complete week of
 * `window`, then the week in progress, flagged. Throws for a set whose exercise has no muscles.
 */
export function weeklyHardSets(
	facts: readonly StrengthFact[],
	exercises: ReadonlyMap<string, ExerciseMuscles>,
	timeZone: string,
	window: Weeks
): HardSetWeek[] {
	const sets = live(facts);
	const credited = new Map(hardSets(sets, exercises, timeZone).map((w) => [w.weekStart, w]));
	// How many by week, as byWeek would total them, in one pass.
	const weekOf = weekStartIn(timeZone);
	const counts = new Map<IsoDate, number>();
	for (const set of sets) {
		if (!isHardSet(isWorking(set), set.rpe)) continue;
		const weekStart = weekOf(set.performedAt);
		counts.set(weekStart, (counts.get(weekStart) ?? 0) + 1);
	}
	const week = (weekStart: IsoDate, inProgress: boolean): HardSetWeek => ({
		weekStart,
		inProgress,
		sets: counts.get(weekStart) ?? 0,
		muscles: credited.get(weekStart)?.muscles ?? {},
		groups: credited.get(weekStart)?.groups ?? {}
	});
	return [
		...weekStarts(window.weeks).map((weekStart) => week(weekStart, false)),
		week(window.inProgress.weekStart, true)
	];
}

/** A group's hard-set range for a week, both ends included: [lowest, highest]. */
export type GroupRange = readonly [number, number];
export type GroupTargets = Partial<Record<MuscleGroup, GroupRange>>;

export type GroupStatus = 'below' | 'within' | 'above' | 'no_target';

export interface GroupSets {
	group: MuscleGroup;
	sets: number;
	target: GroupRange | null;
	status: GroupStatus;
}

export interface GroupWeek {
	weekStart: IsoDate;
	inProgress: boolean;
	/** In M3's group order: each group with hard sets or a target. */
	groups: GroupSets[];
}

function statusOf(sets: number, target: GroupRange | null): GroupStatus {
	if (target === null) return 'no_target';
	const [lo, hi] = target;
	if (!(lo <= hi)) throw new RangeError(`A range runs from low to high: ${lo}–${hi}`);
	if (sets < lo) return 'below';
	return sets > hi ? 'above' : 'within';
}

/**
 * Each week's sets per muscle group against its range (targets, by the week's Monday): below,
 * within (both ends included), above, or no_target. The week in progress keeps its flag, so a
 * screen shows its status as 'so far'.
 */
export function muscleGroupWeeks(
	weeks: readonly HardSetWeek[],
	targets: ReadonlyMap<IsoDate, GroupTargets>
): GroupWeek[] {
	return weeks.map(({ weekStart, inProgress, groups }) => {
		const ranges = targets.get(weekStart) ?? {};
		return {
			weekStart,
			inProgress,
			groups: MUSCLE_GROUPS.flatMap((group) => {
				const sets = groups[group] ?? 0;
				const target = ranges[group] ?? null;
				if (sets === 0 && target === null) return [];
				return [{ group, sets, target, status: statusOf(sets, target) }];
			})
		};
	});
}

// ---- RPE --------------------------------------------------------------------------------------

export interface RpeSummary {
	/** The mean RPE of the working sets that have one; null when none does. */
	mean: number | null;
	/** Working sets, and those with an RPE. */
	sets: number;
	rated: number;
	/** rated ÷ sets, 0 to 1; null with no working set. */
	share: number | null;
}

/** Average RPE over working sets (warm-ups and skipped sets left out), and how many have one. */
export function rpeSummary(facts: readonly StrengthFact[]): RpeSummary {
	const working = live(facts).filter(isWorking);
	const rpes = working.flatMap((set) => (set.rpe === null ? [] : [set.rpe]));
	return {
		mean: mean(rpes),
		sets: working.length,
		rated: rpes.length,
		share: working.length === 0 ? null : cleanFloat(rpes.length / working.length)
	};
}

/** rpeSummary's mean by week: a gap (null) for a week with no rated working set. */
export function weeklyRpe(
	facts: readonly StrengthFact[],
	timeZone: string,
	window: Weeks
): SeriesPoint[] {
	const rated: Timed[] = [];
	for (const set of live(facts))
		if (isWorking(set) && set.rpe !== null) rated.push({ at: set.performedAt, value: set.rpe });
	return fillWeeks(byWeek(rated, timeZone, mean), window.weeks, 'gap', window.inProgress);
}

// ---- Key lifts --------------------------------------------------------------------------------

export interface KeyLift {
	exercise: string;
	baselineLift: BaselineLift | null;
	/** Sessions with a working set of it. */
	sessions: number;
}

/**
 * The lifts Progress follows, at most KEY_LIFTS_MAX: exercises with an e1RM in the facts, those
 * that stand for a profile lift (baselineLift) first, then by sessions, the most recently
 * trained, and id.
 */
export function keyLifts(
	facts: readonly StrengthFact[],
	exercises: ReadonlyMap<string, Pick<StrengthExercise, 'measure' | 'loadType' | 'baselineLift'>>
): KeyLift[] {
	const seen = new Map<string, { workouts: Set<string>; last: number; e1rm: boolean }>();
	for (const set of live(facts)) {
		if (!isWorking(set)) continue;
		const exercise = lookup(exercises, set.exercise);
		const held = seen.get(set.exercise) ?? { workouts: new Set(), last: 0, e1rm: false };
		held.workouts.add(set.workoutId);
		held.last = Math.max(held.last, set.performedAt.getTime());
		held.e1rm ||= e1rmApplies(set, exercise);
		seen.set(set.exercise, held);
	}
	return [...seen]
		.filter(([, held]) => held.e1rm)
		.map(([id, held]) => ({
			lift: {
				exercise: id,
				baselineLift: lookup(exercises, id).baselineLift,
				sessions: held.workouts.size
			},
			last: held.last
		}))
		.sort(
			(a, b) =>
				Number(a.lift.baselineLift === null) - Number(b.lift.baselineLift === null) ||
				b.lift.sessions - a.lift.sessions ||
				b.last - a.last ||
				a.lift.exercise.localeCompare(b.lift.exercise)
		)
		.slice(0, KEY_LIFTS_MAX)
		.map(({ lift }) => lift);
}
