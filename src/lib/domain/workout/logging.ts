/**
 * What every kind of set records and what it counts toward (PRD §8, §9): the one rule the logger,
 * the prefill, the finish summary, the payload schemas and the sync endpoint share, so a set is
 * asked for, refused and counted alike on the device and on the server.
 *
 * - The measure decides the amount: a reps set records reps, a time set seconds, a distance set
 *   metres.
 * - The load type decides the load field and what the set counts toward: LOAD_RULES, the owner's
 *   decision on bodyweight and assisted sets, kept in one table so changing it is an edit here.
 * - Only working reps sets count toward e1RM, volume load and PRs. A warm-up or a skipped set
 *   counts toward nothing; a time or distance set reports its seconds or metres instead.
 * - Every number is M3's or M1's: setE1rm and personalRecords (training/metrics.ts) and
 *   volumeLoad (load.ts), called and never redefined.
 */
import type { E1rmEstimate } from '../e1rm.ts';
import { volumeLoad } from '../load.ts';
import { personalRecords, setE1rm } from '../training/metrics.ts';
import { LOAD_TYPE_LABEL, MEASURE_LABEL } from '../training/vocabulary.ts';
import type { LoadType, Measure } from '../training/vocabulary.ts';
import { convertWeight } from '../units.ts';
import type { FieldErrors } from '../validation.ts';
import type { ExerciseSummary, LoggedSet } from './types.ts';

/** The load a set asks for: the weight lifted, a bodyweight exercise's added weight, or the help. */
export type LoadField = 'weight' | 'added' | 'assistance';

/** The amount a set records, by its exercise's measure. */
export type AmountField = 'reps' | 'seconds' | 'metres';

/** The PRs M4 recognises. */
export const PR_KIND_LABEL = {
	e1rm: 'Estimated 1RM',
	rep_max: 'Rep max',
	most_reps: 'Most reps'
};
export type PrKind = keyof typeof PR_KIND_LABEL;

export interface LoadRule {
	/** The field a set of it asks for; null for none. */
	field: LoadField | null;
	/** Whether a performed set must fill it in. */
	required: boolean;
	/** Whether a reps set's load counts toward volume load (load × reps). */
	volume: boolean;
	/** Whether a reps set gets M3's setE1rm. */
	e1rm: boolean;
	/** The PRs a reps set of it can set; 'e1rm' exactly where `e1rm` holds. */
	prs: readonly PrKind[];
}

/**
 * The owner's decision on load types (M4 open question 23), with the plan's defaults:
 * - external: a performed set needs a weight; it counts toward volume load, M3's e1RM, and e1RM
 *   and rep-max PRs.
 * - bodyweight: an optional added weight, blank for bodyweight only. The added weight counts
 *   toward volume load; there is no e1RM, because body weight is not logged per set. Its only PR
 *   is 'most reps', on unweighted sets.
 * - assisted: the assistance, in its own field and never a weight (lower is harder); optional,
 *   as a band has no number. No e1RM, volume load or PR in M4.
 * - none: no load field; reps, seconds and metres totals only.
 */
export const LOAD_RULES: Readonly<Record<LoadType, LoadRule>> = {
	external: { field: 'weight', required: true, volume: true, e1rm: true, prs: ['e1rm', 'rep_max'] },
	bodyweight: { field: 'added', required: false, volume: true, e1rm: false, prs: ['most_reps'] },
	assisted: { field: 'assistance', required: false, volume: false, e1rm: false, prs: [] },
	none: { field: null, required: false, volume: false, e1rm: false, prs: [] }
};

/** The one measure whose sets count toward e1RM, volume load and PRs. */
const COUNTED_MEASURE: Measure = 'reps';

const AMOUNT_OF: Readonly<Record<Measure, AmountField>> = {
	reps: 'reps',
	time: 'seconds',
	distance: 'metres'
};
const AMOUNTS = Object.values(AMOUNT_OF);

const LOAD_FIELD_LABEL: Readonly<Record<LoadField, string>> = {
	weight: 'Weight',
	added: 'Added weight',
	assistance: 'Assistance'
};

/** Where a set keeps each load: an added weight is a weight, so no query mistakes the help for one. */
const LOAD_COLUMN: Readonly<Record<LoadField, 'weight' | 'assistance'>> = {
	weight: 'weight',
	added: 'weight',
	assistance: 'assistance'
};

/** Each load in the messages: 'Back squat needs a weight'. */
const LOAD_WORDS = { weight: 'a weight', assistance: 'the assistance' } as const;

/** Each amount in the messages: 'Plank needs a time', 'Plank records a time, not reps'. */
const AMOUNT_WORDS: Readonly<Record<AmountField, { a: string; noun: string }>> = {
	reps: { a: 'reps', noun: 'reps' },
	seconds: { a: 'a time', noun: 'time' },
	metres: { a: 'a distance', noun: 'distance' }
};

export interface SetFields {
	load: LoadField | null;
	amount: AmountField;
	labels: {
		load: string | null;
		/** M3's MEASURE_LABEL: 'Reps', 'Time', 'Distance'. */
		amount: string;
		/** What an optional load left blank means, in M3's LOAD_TYPE_LABEL: 'Bodyweight'. */
		blank: string | null;
	};
}

/** The fields a set of this measure and load type asks for, with their labels. */
export function setFields(measure: Measure, loadType: LoadType): SetFields {
	const { field, required } = LOAD_RULES[loadType];
	return {
		load: field,
		amount: AMOUNT_OF[measure],
		labels: {
			load: field && LOAD_FIELD_LABEL[field],
			amount: MEASURE_LABEL[measure],
			blank: field && !required ? LOAD_TYPE_LABEL[loadType] : null
		}
	};
}

/** What checkSet reads of an exercise: its name, for the messages, and its rules. */
export type CheckedExercise = Pick<ExerciseSummary, 'name' | 'measure' | 'loadType'>;

/** What the counting rules read of an exercise. */
export type RuledExercise = Pick<ExerciseSummary, 'measure' | 'loadType'>;

/** A set as the counting rules read it: a performed or a stored set (CanonicalSet). */
export type RuledSet = LoggedSet & { isSkipped: boolean };

/**
 * Field errors, at dotted paths under `payload.`, for a performed set (set.log, set.edit) its
 * exercise cannot record: a missing or foreign amount, missed reps off a reps set, and a load
 * its load type does not take. Empty when the set fits. Ranges are the payload schemas' job.
 */
export function checkSet(
	set: Pick<LoggedSet, AmountField | 'missedReps' | 'weight' | 'assistance'>,
	exercise: CheckedExercise
): FieldErrors {
	const { name, measure, loadType } = exercise;
	const amount = AMOUNT_OF[measure];
	const { field, required } = LOAD_RULES[loadType];
	const errors: FieldErrors = {};
	const refuse = (path: string, message: string) => (errors[`payload.${path}`] = message);
	const recordsInstead = (other: AmountField) =>
		`${name} records ${AMOUNT_WORDS[amount].a}, not ${AMOUNT_WORDS[other].noun}`;

	if (set[amount] === null) refuse(amount, `${name} needs ${AMOUNT_WORDS[amount].a}`);
	for (const other of AMOUNTS)
		if (other !== amount && set[other] !== null) refuse(other, recordsInstead(other));
	if (amount !== 'reps' && set.missedReps !== 0) refuse('missedReps', recordsInstead('reps'));

	const column = field && LOAD_COLUMN[field];
	if (column && required && set[column] === null)
		refuse(column, `${name} needs ${LOAD_WORDS[column]}`);
	if (set.weight !== null && column !== 'weight')
		refuse(
			'weight',
			column === 'assistance' ? `${name} takes assistance, not a weight` : `${name} takes no weight`
		);
	if (set.assistance !== null && column !== 'assistance')
		refuse('assistance', 'Only assisted exercises take assistance');
	return errors;
}

/** A set that counts: performed, and not a warm-up. */
export const isWorking = (set: RuledSet) => !set.isWarmup && !set.isSkipped;
const counts = (exercise: RuledExercise) => exercise.measure === COUNTED_MEASURE;

/**
 * M3's setE1rm where an e1RM applies: a reps set of an exercise whose load type estimates one.
 * Null otherwise, and wherever setE1rm gives none (a warm-up, a skipped set, RPE under 6).
 */
export function e1rmOf(set: RuledSet, exercise: RuledExercise): E1rmEstimate | null {
	if (!counts(exercise) || !LOAD_RULES[exercise.loadType].e1rm) return null;
	return setE1rm(set);
}

/** Whether the set has an e1RM (e1rmOf). */
export function e1rmApplies(set: RuledSet, exercise: RuledExercise): boolean {
	return e1rmOf(set, exercise) !== null;
}

/**
 * A working reps set's volume load in kg, through M1's volumeLoad: the weight, or a bodyweight
 * set's added weight (0 when none is added), times the reps. Null where volume load does not
 * apply: a warm-up, a skipped set, an assisted or unloaded set, a time or distance set.
 */
export function volumeOf(set: RuledSet, exercise: RuledExercise): number | null {
	if (!isWorking(set) || !counts(exercise) || !LOAD_RULES[exercise.loadType].volume) return null;
	const weight = set.weight === null ? 0 : convertWeight(set.weight, set.unit, 'kg');
	return volumeLoad([{ weight, reps: set.reps ?? 0 }]);
}

export interface Totals {
	reps: number;
	seconds: number;
	metres: number;
}

/** The working sets' amounts: only the one the exercise's measure records; the others stay 0. */
export function totals(sets: readonly RuledSet[], exercise: RuledExercise): Totals {
	const amount = AMOUNT_OF[exercise.measure];
	const sum: Totals = { reps: 0, seconds: 0, metres: 0 };
	for (const set of sets) if (isWorking(set)) sum[amount] += set[amount] ?? 0;
	return sum;
}

/** The PRs an exercise can have: none off reps sets, else its load type's (LOAD_RULES). */
export function prKinds(exercise: RuledExercise): readonly PrKind[] {
	return counts(exercise) ? LOAD_RULES[exercise.loadType].prs : [];
}

/** The instant personalRecords needs to read a set; a candidate does not depend on it. */
const ANY_TIME = new Date(0);

const CANDIDATE: Readonly<Record<PrKind, (set: RuledSet, exercise: RuledExercise) => boolean>> = {
	e1rm: e1rmApplies,
	// M3's personalRecords decides which sets have a rep max: a load, and 1 to PR_MAX_REPS reps.
	rep_max: (set) => personalRecords([{ ...set, performedAt: ANY_TIME }]).length > 0,
	// 'Most reps' is for bodyweight alone: a set with weight added competes for none.
	most_reps: (set) => (set.weight ?? 0) <= 0 && (set.reps ?? 0) >= 1
};

/** The PRs a set competes for, in prKinds' order; none for a warm-up or a skipped set. */
export function prCandidates(set: RuledSet, exercise: RuledExercise): PrKind[] {
	if (!isWorking(set)) return [];
	return prKinds(exercise).filter((kind) => CANDIDATE[kind](set, exercise));
}
