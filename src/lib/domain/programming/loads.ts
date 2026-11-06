/**
 * Week 1's loads (PRD §5; the M3 brief's baseline rules): each main lift loaded from its baseline
 * by rules/loads.ts, never aggressively. A main lift is a planned exercise with a top set and a
 * baseline lift; every other exercise, and every line other than a main lift's top and back-off
 * sets, stays as the strength stage prescribed it.
 *
 * - A blank 1RM: the top set stays RPE-based, a set of its reps worked up to at the week's RPE cap
 *   (5 @ RPE 7), with BASELINE_INSTRUCTION. Its back-offs are from_e1rm at backOffShare of the
 *   share M1's table gives that set, so they load from the estimate it gives.
 * - A measured 1RM: percent_1rm, basis measured, a snapshot of the 1RM, at baselineShare: under
 *   M1's percentOfOneRepMax for the reps at the cap (72.5 % × 5 against 78.6 %), the cap kept.
 * - An estimated 1RM: the same with basis estimated, estimateDiscount lower, and
 *   ESTIMATE_INSTRUCTION, so the RPE bounds it.
 *
 * M1's maths is reused, never redefined: percentOfOneRepMax for the table, roundToIncrement for
 * the rounding. Pure and deterministic.
 */
import { percentOfOneRepMax } from '../rpe.ts';
import { BASELINE_INSTRUCTION } from '../training/describe.ts';
import type {
	BaselineLift,
	PlannedExercisePlan,
	SetPrescription,
	WeekPlan
} from '../training/types.ts';
import type { LoadBasis } from '../training/vocabulary.ts';
import { roundToIncrement } from '../units.ts';
import type { InputBaseline, ProgrammingInput } from './input.ts';
import { LOAD_RULES } from './rules/loads.ts';
import type { LoadRules } from './rules/loads.ts';

/** What a lift loaded from an estimated 1RM asks: the RPE bounds it, whatever the percentage. */
export const ESTIMATE_INSTRUCTION =
	'Your 1RM for this lift is an estimate: if a set feels harder than its RPE, take weight off.';

/** A main lift: the baseline lift its loads are shares of, and that lift's 1RM if known. */
export interface MainLift {
	lift: BaselineLift;
	oneRepMax: InputBaseline | null;
}

const topOf = (planned: PlannedExercisePlan) => planned.sets.find((s) => s.role === 'top');

/** The reps a main lift's top set counts; null when it has none (a hold or a carry). */
export const topReps = (planned: PlannedExercisePlan) => {
	const top = topOf(planned);
	return top ? (top.repsMax ?? top.repsMin) : null;
};

/** `planned`'s baseline lift and its 1RM, when it is a main lift. */
export function mainLiftOf(planned: PlannedExercisePlan, input: ProgrammingInput): MainLift | null {
	const lift = planned.baselineLift;
	return lift && topOf(planned) ? { lift, oneRepMax: input.baselines[lift] } : null;
}

/** `week` with `load` applied to each main lift of its strength sessions. */
export function eachMain(
	week: WeekPlan,
	input: ProgrammingInput,
	load: (planned: PlannedExercisePlan, main: MainLift) => PlannedExercisePlan
): WeekPlan {
	const sessions = week.sessions.map((session) => {
		if (session.kind !== 'strength') return session;
		const exercises = session.exercises.map((planned) => {
			const main = mainLiftOf(planned, input);
			return main ? load(planned, main) : planned;
		});
		return { ...session, exercises };
	});
	return { ...week, sessions };
}

/** A share of a 1RM on the rules' step, rounded down so a load never rounds up. */
export const roundShare = (share: number, rules: LoadRules) =>
	roundToIncrement(share, rules.loadRounding, 'down');

/**
 * Week 1's share of a known 1RM for a top set of `reps` at `rpeCap`: measuredShare of M1's table,
 * an estimate estimateDiscount lower. Null off the table.
 */
export function baselineShare(
	reps: number,
	rpeCap: number,
	basis: LoadBasis,
	rules: LoadRules = LOAD_RULES
): number | null {
	const table = percentOfOneRepMax(reps, rpeCap);
	if (table === null) return null;
	const discount = basis === 'estimated' ? rules.estimateDiscount : 0;
	return roundShare(table * rules.measuredShare - discount, rules);
}

/** `line` at `share` of a known 1RM (percent_1rm of a snapshot of it), or of the estimate. */
function atShare(
	line: SetPrescription,
	share: number,
	oneRepMax: InputBaseline | null
): SetPrescription {
	const known = oneRepMax !== null;
	return {
		...line,
		loadKind: known ? 'percent_1rm' : 'from_e1rm',
		loadValue: share,
		loadUnit: null,
		loadBasis: oneRepMax?.kind ?? null,
		reference1rm: oneRepMax?.kg ?? null,
		reference1rmUnit: known ? 'kg' : null
	};
}

/**
 * A main lift with its top set at `share` of its 1RM, or by RPE as a baseline set (`share` is then
 * the share M1's table gives it), and its back-offs at backOffShare of `share`.
 */
export function loadMain(
	planned: PlannedExercisePlan,
	{ oneRepMax }: MainLift,
	share: number,
	baseline: boolean,
	rules: LoadRules = LOAD_RULES
): PlannedExercisePlan {
	const backOff = roundShare(share * rules.backOffShare, rules);
	const estimated = oneRepMax?.kind === 'estimated';
	return {
		...planned,
		instructions: baseline
			? BASELINE_INSTRUCTION
			: estimated
				? ESTIMATE_INSTRUCTION
				: planned.instructions,
		sets: planned.sets.map((line) =>
			line.role === 'back_off'
				? atShare(line, backOff, oneRepMax)
				: line.role === 'top' && !baseline
					? atShare(line, share, oneRepMax)
					: line
		)
	};
}

/**
 * A main lift as its first week prescribes it at `rpeCap`: a baseline set with a blank 1RM, a
 * known 1RM's baselineShare otherwise. Off M1's table it stays as prescribed.
 */
export function loadBaseline(
	planned: PlannedExercisePlan,
	main: MainLift,
	rpeCap: number,
	rules: LoadRules = LOAD_RULES
): PlannedExercisePlan {
	const reps = topReps(planned);
	if (reps === null) return planned;
	const share = main.oneRepMax
		? baselineShare(reps, rpeCap, main.oneRepMax.kind, rules)
		: percentOfOneRepMax(reps, rpeCap);
	return share === null ? planned : loadMain(planned, main, share, !main.oneRepMax, rules);
}
