/**
 * Each week's main-lift prescription by the block's phase (M7's generator-phasing slice; PRD §5).
 * It runs after placement and before volume, because volume counts the hard sets it sets, and
 * loads and progression load what it prescribes.
 *
 * - A week whose targets carry mainLifts (the strength phases' and the hypertrophy block's weeks)
 *   gives each main lift (the main slot's exercise, the one with a top set) the week's reps and
 *   top RPE, its back-off sets a point under the top set. The loads stage and progression then
 *   load the baseline lifts among them through M1's percentOfOneRepMax at that top RPE
 *   (../progression.ts mainRpe): a measured 1RM, an estimate and a blank one each as M3 loads
 *   them. The week's sets factor is its volumeFactor, which the volume stage counts and
 *   progression applies.
 * - Realization and taper weeks (HALVED_ACCESSORY_PHASES) keep only the first half of the work
 *   beside the main lifts, the slots selection filled first: peak weeks practise the competition
 *   lifts and shed the rest of the fatigue.
 * - A strength stream held at maintenance (the goal's mode in prepare's input.modes) keeps M3's
 *   maintenance prescription (STYLES.maintenance, which chooseSplit already gave it), with its
 *   main lifts' top set capped at the dose's RPE (DOSES.strength.topSetRpeCap); so is the week's
 *   RPE cap, which loads and progression read.
 * - Without a season, and with every goal paused, the weeks stay exactly as M3 builds them.
 *
 * Pure and deterministic.
 */
import { sessionLoadOf } from '../../training/metrics.ts';
import type {
	BlockPlan,
	PlannedExercisePlan,
	SessionPlan,
	StrengthSessionPlan,
	WeekPlan,
	WeekTargets
} from '../../training/types.ts';
import type { Phase } from '../../training/vocabulary.ts';
import type { GoalMode } from '../evaluate/types.ts';
import type { ProgrammingInput } from '../input.ts';
import { DOSES } from '../rules/maintenance.ts';
import { INTENSITY_BY_RPE } from '../rules/strength.ts';
import { strengthDiscipline } from '../splits.ts';
import type { Stage } from '../stage.ts';
import { estimateMinutes } from '../timefit.ts';

/** The block phases whose weeks keep only the first half of the work beside the main lifts. */
export const HALVED_ACCESSORY_PHASES: readonly Phase[] = ['realization', 'taper'];

/**
 * The mode prepare gave the goal the strength sessions serve (chooseSplit's goal); null with no
 * modes, as for a program planned without a season, and with every goal paused.
 */
export function strengthMode(input: ProgrammingInput): GoalMode | null {
	const discipline = strengthDiscipline(input);
	if (!discipline || input.maintenance) return null;
	const ref = input.refs.goals[input.goals.findIndex((g) => g.disciplines.includes(discipline))];
	return (ref !== undefined && input.modes?.[ref]) || null;
}

const isGenerated = (s: SessionPlan): s is StrengthSessionPlan =>
	s.kind === 'strength' && s.source === 'generator';
const isMainLine = (e: PlannedExercisePlan) => e.sets.some((line) => line.role === 'top');

/** `planned`'s top set at `top` and its back-offs a point under it, at least RPE 5. */
const atRpe = (planned: PlannedExercisePlan, top: number): PlannedExercisePlan => ({
	...planned,
	sets: planned.sets.map((line) =>
		line.role === 'top'
			? { ...line, targetRpe: top }
			: line.role === 'back_off'
				? { ...line, targetRpe: Math.max(5, top - 1) }
				: line
	)
});

/** A main lift with the week's reps on every line counted in reps, at its top RPE. */
function phased(planned: PlannedExercisePlan, mainLifts: NonNullable<WeekTargets['mainLifts']>) {
	const { repsMin, repsMax, topRpe } = mainLifts;
	const sets = planned.sets.map((line) =>
		line.repsMin === null ? line : { ...line, repsMin, repsMax }
	);
	return atRpe({ ...planned, sets }, topRpe);
}

/** A main lift with its top set no harder than `cap`. */
function capped(planned: PlannedExercisePlan, cap: number): PlannedExercisePlan {
	const top = planned.sets.find((line) => line.role === 'top')!;
	return top.targetRpe !== null && top.targetRpe > cap ? atRpe(planned, cap) : planned;
}

/** The main lifts, then the first half (rounded up) of the rest, in selection's order. */
function halved(exercises: readonly PlannedExercisePlan[]): PlannedExercisePlan[] {
	const rest = exercises.filter((e) => !isMainLine(e));
	const kept = new Set(rest.slice(0, Math.ceil(rest.length / 2)));
	return exercises.filter((e) => isMainLine(e) || kept.has(e));
}

/**
 * `week`'s generated strength sessions with `change` made to their exercises, each at most `cap`
 * hard, its intensity, minutes and load estimated again.
 */
function eachSession(
	week: WeekPlan,
	input: ProgrammingInput,
	cap: number,
	change: (exercises: readonly PlannedExercisePlan[]) => PlannedExercisePlan[]
): SessionPlan[] {
	return week.sessions.map((session) => {
		if (!isGenerated(session)) return session;
		const exercises = change(session.exercises);
		const targetRpe = Math.min(session.targetRpe, cap);
		const estMinutes = estimateMinutes({ exercises }, input);
		return {
			...session,
			exercises,
			targetRpe,
			intensity: INTENSITY_BY_RPE.find(([under]) => targetRpe < under)![1],
			estMinutes,
			estLoad: sessionLoadOf({ estMinutes, targetRpe })
		};
	});
}

/** `week` of `block` as its phase prescribes it; `dosed` when its strength is held at a dose. */
export function phaseWeek(
	week: WeekPlan,
	block: Pick<BlockPlan, 'phase'>,
	input: ProgrammingInput,
	dosed: boolean
): WeekPlan {
	const { targets } = week;
	if (!week.sessions.some(isGenerated)) return week;
	const main = (fn: (e: PlannedExercisePlan) => PlannedExercisePlan) => (e: PlannedExercisePlan) =>
		isMainLine(e) ? fn(e) : e;
	if (dosed) {
		const cap = Math.min(targets.rpeCap, DOSES.strength.topSetRpeCap);
		const sessions = eachSession(week, input, cap, (exercises) =>
			exercises.map(main((e) => capped(e, cap)))
		);
		return { ...week, targets: { ...targets, rpeCap: cap }, sessions };
	}
	const { mainLifts } = targets;
	if (!mainLifts) return week;
	const halve = HALVED_ACCESSORY_PHASES.includes(block.phase);
	const sessions = eachSession(week, input, targets.rpeCap, (exercises) => {
		const phasedOnes = exercises.map(main((e) => phased(e, mainLifts)));
		return halve ? halved(phasedOnes) : phasedOnes;
	});
	return { ...week, sessions };
}

export const phasing: Stage = (draft, { input }) => {
	if (!draft.periodisation) return draft;
	const dosed = strengthMode(input) === 'maintenance';
	const blocks = draft.blocks.map((block) =>
		block.outline
			? block
			: { ...block, weeks: block.weeks.map((week) => phaseWeek(week, block, input, dosed)) }
	);
	return { ...draft, blocks };
};
