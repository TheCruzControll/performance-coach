/**
 * The workout summary (PRD §7, §9): what the finish screen and History show of a workout, worked
 * out from the projected view (project.ts), so the device offline and the server give the same
 * numbers for the same rows.
 *
 * - Counting is logging.ts's: only working sets count, by measure and load type (LOAD_RULES). The
 *   view holds no deleted set; a warm-up counts toward nothing, a skipped set only as skipped.
 * - Every formula is M1's or M3's, called and never redefined: setE1rm and personalRecords
 *   (through logging.ts), volumeLoad (through volumeOf), sessionLoadOf, sessionLoad and
 *   paceSecondsPer. An e1RM is always an estimate, and says so.
 * - Loads are compared in kg and reported in the owner's unit, free of floating-point noise
 *   (cleanFloat). A stored set's e1rmKg is the server's and is never read, so a set counts the
 *   same before and after it syncs.
 * - A PR beats a best from before this workout strictly. An exercise never done before reads
 *   'First time' and sets no PR; one whose bests are not known sets none either.
 */
import type { E1rmEstimate } from '../e1rm.ts';
import { sessionLoad } from '../load.ts';
import { personalRecords, sessionLoadOf } from '../training/metrics.ts';
import type { CustomMetric, SessionKind } from '../training/types.ts';
import type { Measure, OtherSessionKind } from '../training/vocabulary.ts';
import { cleanFloat, convertWeight, paceSecondsPer } from '../units.ts';
import {
	e1rmOf,
	isWorking,
	PR_KIND_LABEL,
	prCandidates,
	setFields,
	totals,
	volumeOf
} from './logging.ts';
import type { PrKind, RuledExercise, RuledSet, Totals } from './logging.ts';
import type { CanonicalSet } from './protocol.ts';
import { stopwatchElapsed } from './timers.ts';
import type { KitUnits, PriorBest, StartKit, WorkoutView } from './types.ts';

// ---- Bests ----------------------------------------------------------------------------------

/** An exercise's bests: what a PR must beat, or what a workout reached. */
export interface ExerciseBests {
	/** The best estimated 1RM, in kg; always an estimate. */
	e1rmKg: number | null;
	/** The heaviest load for each rep count, as M3's personalRecords keeps them. */
	repMaxes: readonly Pick<PriorBest, 'reps' | 'weightKg'>[];
	/** The most reps in one set with no weight added (bodyweight exercises). */
	mostReps: number | null;
}

/**
 * The bests from before this workout, by exercise id:
 * - an exercise's bests, which its PRs must beat
 * - null for an exercise never done before: it reads 'First time' and sets no PR
 * - absent where they are not known (the kit carries none for a substitute or an added
 *   exercise): no PR, and no 'First time' either
 */
export type PriorBests = Readonly<Record<string, ExerciseBests | null>>;

/** The instant personalRecords needs to read a set; which set it keeps on a tie does not matter. */
const ANY_TIME = new Date(0);

const highest = (values: number[]) => (values.length > 0 ? Math.max(...values) : null);

/**
 * The bests among an exercise's sets, each from the sets that compete for its PR kind
 * (prCandidates): none from a warm-up, a skipped set, or a load type without that PR.
 */
export function bestsOf(sets: readonly RuledSet[], exercise: RuledExercise): ExerciseBests {
	const competing = (kind: PrKind) =>
		sets.filter((set) => prCandidates(set, exercise).includes(kind));
	const lifted = competing('rep_max').map((set) => ({ ...set, performedAt: ANY_TIME }));
	return {
		e1rmKg: highest(competing('e1rm').flatMap((set) => e1rmOf(set, exercise)?.value ?? [])),
		repMaxes: personalRecords(lifted).map(({ reps, weightKg }) => ({ reps, weightKg })),
		mostReps: highest(competing('most_reps').map((set) => set.reps ?? 0))
	};
}

/**
 * The bests a strength kit carried, by planned exercise id: null for an exercise with no previous
 * session and no bests, which is its first time. A run's or an other session's kit carries none.
 */
export function kitBests(kit: StartKit | null): PriorBests {
	const prior: Record<string, ExerciseBests | null> = {};
	if (kit?.kind !== 'strength') return prior;
	for (const { exercise, previous, bestE1rm, priorBests, mostReps } of kit.exercises) {
		const done =
			previous !== null || bestE1rm !== null || priorBests.length > 0 || mostReps !== null;
		prior[exercise.id] = done
			? { e1rmKg: bestE1rm?.kg ?? null, repMaxes: priorBests, mostReps }
			: null;
	}
	return prior;
}

// ---- PRs ------------------------------------------------------------------------------------

export interface Pr {
	kind: PrKind;
	/** PR_KIND_LABEL's: 'Estimated 1RM', 'Rep max', 'Most reps'. */
	label: string;
	exerciseId: string;
	name: string;
	/** A rep max's rep count; null for the others. */
	reps: number | null;
	/** The new best and the one it beat: a load in the summary's unit, or reps for 'Most reps'. */
	value: number;
	previous: number;
	/** True for an e1RM, which is an estimate and never a measured max. */
	estimated: boolean;
}

type Beaten = Pick<Pr, 'kind' | 'reps' | 'value' | 'previous'>;

/** Above beyond floating-point noise, so a load converted by another route still ties. */
const above = (value: number, prior: number) => cleanFloat(value) > cleanFloat(prior);

/** Today's bests that beat the prior ones, in kg or reps: a kind with no prior best sets none. */
function beaten(today: ExerciseBests, prior: ExerciseBests): Beaten[] {
	const found: Beaten[] = [];
	const check = (kind: PrKind, value: number | null, previous: number | null) => {
		if (value !== null && previous !== null && above(value, previous))
			found.push({ kind, reps: null, value, previous });
	};
	check('e1rm', today.e1rmKg, prior.e1rmKg);
	for (const { reps, weightKg } of today.repMaxes) {
		const held = prior.repMaxes.find((best) => best.reps === reps);
		if (held && above(weightKg, held.weightKg))
			found.push({ kind: 'rep_max', reps, value: weightKg, previous: held.weightKg });
	}
	check('most_reps', today.mostReps, prior.mostReps);
	return found;
}

// ---- Each exercise --------------------------------------------------------------------------

/** The set an exercise's line shows, as it was entered, with its e1RM where one applies. */
export interface BestSet extends Pick<
	CanonicalSet,
	'id' | 'setIndex' | 'reps' | 'seconds' | 'metres' | 'weight' | 'assistance' | 'unit' | 'rpe'
> {
	/** M3's setE1rm in the summary's unit: always an estimate. */
	e1rm: E1rmEstimate | null;
}

export interface SetCounts {
	/** Working sets performed. */
	done: number;
	skipped: number;
}

export interface ExerciseResult {
	exerciseId: string;
	name: string;
	measure: Measure;
	sets: SetCounts;
	/** Volume load in the summary's unit; null where none applies (no set carried a counted load). */
	volume: number | null;
	/** The working sets' reps, seconds or metres, by the exercise's measure. */
	totals: Totals;
	best: BestSet | null;
	/** Never done before this workout: it reads 'First time' and sets no PR. */
	firstTime: boolean;
}

/**
 * The best of an exercise's working sets: the highest e1RM where one applies, else the heaviest
 * load (for an assisted exercise the least help, help left blank last), then the most reps,
 * seconds or metres. Ties go to the later set, as M3's bests do.
 */
function bestSet(working: readonly CanonicalSet[], exercise: RuledExercise) {
	const amount = setFields(exercise.measure, exercise.loadType).amount;
	const kg = (set: CanonicalSet, load: number | null) =>
		load === null ? null : convertWeight(load, set.unit, 'kg');
	const rank = (set: CanonicalSet) => [
		e1rmOf(set, exercise)?.value ?? -Infinity,
		exercise.loadType === 'assisted'
			? -(kg(set, set.assistance) ?? Infinity)
			: (kg(set, set.weight) ?? 0),
		set[amount] ?? 0
	];
	const outranks = (a: number[], b: number[]) => {
		const i = a.findIndex((value, at) => value !== b[at]);
		return i === -1 || a[i]! > b[i]!;
	};
	let best: CanonicalSet | null = null;
	for (const set of working) if (!best || outranks(rank(set), rank(best))) best = set;
	return best;
}

// ---- The workout ----------------------------------------------------------------------------

export interface RunSummary {
	/** The run's own distance and duration (run.log), each null until recorded. */
	distanceMetres: number | null;
	durationSeconds: number | null;
	/** Seconds per km or mile (units.distance), by M1's paceSecondsPer; null until both are known. */
	pace: number | null;
	avgHr: number | null;
}

export interface OtherSummary {
	kind: OtherSessionKind;
	durationMinutes: number;
	rpe: number | null;
	/**
	 * M1's sessionLoad(minutes, RPE) of the other.log record; null until its RPE is. Shown only
	 * with the session's details: the session's load is WorkoutSummary.sessionLoad.
	 */
	load: number | null;
	metrics: CustomMetric[];
}

export interface WorkoutSummary {
	kind: SessionKind;
	/** The owner's units: every load here is in `units.weight`, every pace per `units.distance`. */
	units: KitUnits;
	/** Time spent training, pauses left out: the duration recorded, else the stopwatch's. */
	durationSeconds: number | null;
	sessionRpe: number | null;
	/**
	 * M3's sessionLoadOf, the duration in minutes × the session RPE; null until both are known. The
	 * session's load for every kind, from the workout row: the one the finish screen and History
	 * show, and the one M3's sessionsInRange counts.
	 */
	sessionLoad: number | null;
	sets: SetCounts;
	/** The exercises' volume load; null where none applies. */
	volume: number | null;
	totals: Totals;
	/** In slot order, each under the exercise its sets name. */
	exercises: ExerciseResult[];
	prs: Pr[];
	run: RunSummary | null;
	other: OtherSummary | null;
}

/**
 * The recorded duration (the finish sheet's, the server's row) when there is one, else the
 * stopwatch's to the nearest second. A running stopwatch needs `now` to be read.
 */
function durationOf({ workout, device: { stopwatch } }: WorkoutView, now?: number) {
	if (workout.durationSeconds !== null) return workout.durationSeconds;
	if (stopwatch.startedAt === null || (stopwatch.runningSince !== null && now === undefined))
		return null;
	return Math.round(stopwatchElapsed(stopwatch, now ?? 0) / 1000);
}

const TOTAL_KEYS = ['reps', 'seconds', 'metres'] as const;

/** The view's live sets by the exercise each names, in slot order. */
function byExercise(view: WorkoutView): Map<string, CanonicalSet[]> {
	const groups = new Map<string, CanonicalSet[]>();
	for (const set of view.slots.flatMap((slot) => slot.sets)) {
		groups.set(set.exerciseId, [...(groups.get(set.exerciseId) ?? []), set]);
	}
	return groups;
}

/**
 * The summary of a workout as `view` holds it, against the bests from before it.
 * - `units`: the owner's training-profile units, which every load and pace is reported in.
 * - `now`: this device's clock in epoch ms, to read a stopwatch still running (before Finish);
 *   left out, a running stopwatch gives no duration. The server's views have an idle one.
 */
export function summarizeWorkout(
	view: WorkoutView,
	priorBests: PriorBests,
	units: KitUnits,
	now?: number
): WorkoutSummary {
	const inUnit = (kg: number) => cleanFloat(convertWeight(kg, 'kg', units.weight));
	const exercises: ExerciseResult[] = [];
	const prs: Pr[] = [];
	const sets: SetCounts = { done: 0, skipped: 0 };
	const sum: Totals = { reps: 0, seconds: 0, metres: 0 };
	let volumeKg = 0;

	for (const [exerciseId, all] of byExercise(view)) {
		const exercise = view.exercises[exerciseId];
		if (!exercise) throw new RangeError(`No exercise known for '${exerciseId}'`);
		const { name, measure } = exercise;
		const working = all.filter(isWorking);
		const counts = { done: working.length, skipped: all.filter((s) => s.isSkipped).length };
		const amounts = totals(working, exercise);
		const kg = working.reduce((total, set) => total + (volumeOf(set, exercise) ?? 0), 0);
		const best = bestSet(working, exercise);
		const estimate = best && e1rmOf(best, exercise);
		const prior = priorBests[exerciseId];
		exercises.push({
			exerciseId,
			name,
			measure,
			sets: counts,
			volume: kg > 0 ? inUnit(kg) : null,
			totals: amounts,
			best: best && {
				...pickBest(best),
				e1rm: estimate && { ...estimate, value: inUnit(estimate.value) }
			},
			firstTime: prior === null
		});
		for (const pr of prior ? beaten(bestsOf(working, exercise), prior) : []) {
			// 'Most reps' counts reps; every other PR is a load.
			const report = pr.kind === 'most_reps' ? (n: number) => n : inUnit;
			const { value, previous } = pr;
			prs.push({
				...pr,
				label: PR_KIND_LABEL[pr.kind],
				exerciseId,
				name,
				value: report(value),
				previous: report(previous),
				estimated: pr.kind === 'e1rm'
			});
		}
		sets.done += counts.done;
		sets.skipped += counts.skipped;
		for (const key of TOTAL_KEYS) sum[key] += amounts[key];
		volumeKg += kg;
	}

	const durationSeconds = durationOf(view, now);
	const { sessionRpe } = view.workout;
	return {
		kind: view.workout.kind,
		units,
		durationSeconds,
		sessionRpe,
		sessionLoad: sessionLoadOf({ durationSeconds, sessionRpe }),
		sets,
		volume: volumeKg > 0 ? inUnit(volumeKg) : null,
		totals: sum,
		exercises,
		prs,
		run: runOf(view.run, units),
		other: otherOf(view.other)
	};
}

function pickBest(set: CanonicalSet): Omit<BestSet, 'e1rm'> {
	const { id, setIndex, reps, seconds, metres, weight, assistance, unit, rpe } = set;
	return { id, setIndex, reps, seconds, metres, weight, assistance, unit, rpe };
}

function runOf(run: WorkoutView['run'], units: KitUnits): RunSummary | null {
	if (!run) return null;
	const { distanceMetres, durationSeconds, avgHr } = run;
	const pace =
		distanceMetres !== null && durationSeconds !== null
			? paceSecondsPer(durationSeconds, distanceMetres, units.distance)
			: null;
	return { distanceMetres, durationSeconds, pace, avgHr };
}

function otherOf(other: WorkoutView['other']): OtherSummary | null {
	if (!other) return null;
	const { kind, durationMinutes, rpe, metrics } = other;
	const load = rpe === null ? null : sessionLoad(durationMinutes, rpe);
	return { kind, durationMinutes, rpe, load, metrics };
}
