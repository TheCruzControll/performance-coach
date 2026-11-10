/**
 * Progression from results (M6), after M3's progression stage when generateNextBlock runs the stage
 * list: each main lift's starting progression moved by what its last sessions showed
 * (../results.ts decideFromResults), and the directed deload said.
 *
 * - A main lift loaded as a share of a 1RM (percent_1rm or from_e1rm, an external load) is judged
 *   on its top set in the first week that holds it, against the week's RPE cap. A load change
 *   scales its top and back-off shares in every week by the same ratio, rounded down onto the
 *   loads rules' step and never above M1's table for the line's reps at its week's cap.
 * - A held block (the directives' progression is hold, low adherence or high fatigue) applies no
 *   increase: the lift holds and its decision says why.
 * - An RPE-based lift (no estimate yet) keeps its baseline set: there is nothing to move from.
 * - Every lift judged gets a results_progression decision with results.ts's why, its change and pct
 *   read from the first week's top set as applied (a change the step rounds away holds); a directed
 *   deload gets a deload_scheduled one.
 */
import type { Exposure } from '../../analytics/prescribed.ts';
import type { TrendResult } from '../../analytics/trend.ts';
import { percentOfOneRepMax } from '../../rpe.ts';
import type { SetPrescription, WeekPlan } from '../../training/types.ts';
import { cleanFloat } from '../../units.ts';
import type { WeightUnit } from '../../units.ts';
import { toExerciseKey } from '../input.ts';
import type { ExerciseKey } from '../input.ts';
import { eachMain, roundShare } from '../loads.ts';
import type { DeloadPlacement } from '../review/directives.ts';
import { decideFromResults } from '../results.ts';
import type { ResultOutcome } from '../results.ts';
import { LOAD_RULES } from '../rules/loads.ts';
import { RESULT_RULES } from '../rules/results.ts';
import { exerciseOf } from '../selection.ts';
import type { Stage } from '../stage.ts';

/** What one lift's sessions in the reviewed block showed: analytics/prescribed.ts and trend.ts. */
export interface LiftResults {
	exercise: ExerciseKey;
	exposures: readonly Exposure[];
	trend: TrendResult | null;
}

export interface ResultsStage {
	results: readonly LiftResults[];
	/** The owner's weight unit. */
	unit: WeightUnit;
	hold: boolean;
	deload: DeloadPlacement;
}

/** Why a directed deload sits where it does, in deload_scheduled's words (a whole sentence). */
export const DELOAD_REASON: Record<Exclude<DeloadPlacement, 'none'>, string> = {
	first: 'Your cycle review found fatigue to clear before the block builds again.',
	last: 'Your cycle review asks for one after the block’s build, so it ends lighter.'
};

/** Held: what a results_progression decision adds to an increase a held block does not apply. */
export const HELD_WHY = ' This block adds no load, so it holds where it is.';

/** Not applied: what it adds to a change the plan does not make (the loads step rounds it away). */
export const ROUNDED_WHY =
	' On this block’s load steps that comes to no change, so it holds where it is.';

const SHARES = ['percent_1rm', 'from_e1rm'];
const percent = (pct: number) => `${pct > 0 ? '+' : '−'}${cleanFloat(Math.abs(pct), 1)} %`;

/** `line`'s share scaled by `ratio`, on the loads rules' step and under M1's table at `rpeCap`. */
function scaled(line: SetPrescription, ratio: number, rpeCap: number): SetPrescription {
	if (line.loadValue === null || !SHARES.includes(line.loadKind)) return line;
	const reps = line.repsMax ?? line.repsMin;
	const table =
		reps === null ? null : percentOfOneRepMax(reps, Math.min(line.targetRpe ?? rpeCap, rpeCap));
	const share = roundShare(line.loadValue * ratio, LOAD_RULES);
	return { ...line, loadValue: cleanFloat(table === null ? share : Math.min(share, table), 4) };
}

/** `key`'s first top set in `week`. */
const topOf = (week: WeekPlan, key: ExerciseKey) =>
	week.sessions
		.flatMap((s) => (s.kind === 'strength' ? s.exercises : []))
		.filter((p) => toExerciseKey(p.exercise) === key)
		.flatMap((p) => p.sets.filter((line) => line.role === 'top'))[0];

/** The change a decision states, from the top set before and after: what the plan really does. */
function changeOf(outcome: ResultOutcome, before: SetPrescription, after: SetPrescription) {
	const pct = cleanFloat(((after.loadValue ?? 0) / (before.loadValue ?? 1) - 1) * 100, 2);
	if (pct !== 0) return { change: `${percent(pct)} on its starting load`, pct };
	return { change: outcome.action === 'planned' ? 'as planned' : 'holds', pct: 0 };
}

export function results({ results: lifts, unit, hold, deload }: ResultsStage): Stage {
	const byKey = new Map(lifts.map((r) => [r.exercise, r]));
	return (draft, { input, log }) => {
		const block = draft.blocks[0];
		if (!block) return draft;
		// Each judged lift's outcome, from the first week that holds it, and what it changes.
		const told: { key: ExerciseKey; w: number; name: string; outcome: ResultOutcome }[] = [];
		const ratios = new Map<ExerciseKey, number>();
		const judged = new Set<ExerciseKey>();
		block.weeks.forEach((week, w) =>
			eachMain(week, input, (planned, main) => {
				const key = toExerciseKey(planned.exercise);
				const top = planned.sets.find((line) => line.role === 'top');
				const exercise = exerciseOf(input, key);
				const result = byKey.get(key);
				if (judged.has(key) || !top || !exercise || !result) return planned;
				judged.add(key);
				if (!SHARES.includes(top.loadKind) || exercise.loadType !== 'external') return planned;
				const outcome = decideFromResults(
					result.exposures,
					{
						name: exercise.name,
						line: top,
						loadType: exercise.loadType,
						pattern: exercise.pattern
					},
					result.trend,
					{ unit, e1rmKg: input.baselines[main.lift]?.kg ?? null, rpeCap: week.targets.rpeCap }
				);
				told.push({ key, w, name: exercise.name, outcome });
				const up = (outcome.to ?? 0) > (outcome.from ?? 0);
				if (outcome.field === 'load' && !(hold && up)) ratios.set(key, outcome.to! / outcome.from!);
				return planned;
			})
		);
		const weeks = block.weeks.map((week) =>
			eachMain(week, input, (planned) => {
				const ratio = ratios.get(toExerciseKey(planned.exercise));
				if (ratio === undefined) return planned;
				const sets = planned.sets.map((line) =>
					line.role === 'top' || line.role === 'back_off'
						? scaled(line, ratio, week.targets.rpeCap)
						: line
				);
				return { ...planned, sets };
			})
		);
		for (const { key, w, name, outcome } of told) {
			const up = (outcome.to ?? 0) > (outcome.from ?? 0);
			const { change, pct } = changeOf(
				outcome,
				topOf(block.weeks[w]!, key)!,
				topOf(weeks[w]!, key)!
			);
			const reason =
				hold && up
					? `${outcome.why}${HELD_WHY}`
					: outcome.field !== null && pct === 0
						? `${outcome.why}${ROUNDED_WHY}`
						: outcome.why;
			log.add('results_progression', outcome.ruleKey, ['blocks.0'], {
				...outcome.evidence,
				exercise: name,
				change,
				reason,
				pct,
				significant: Math.abs(pct) >= RESULT_RULES.significantPct
			});
		}
		if (deload !== 'none') {
			const at = weeks.findIndex((w) => w.kind === 'deload');
			if (at >= 0)
				log.add('deload_scheduled', `results.deload_${deload}`, [`blocks.0.weeks.${at}`], {
					week: at + 1,
					rpeCap: weeks[at]!.targets.rpeCap,
					reason: DELOAD_REASON[deload]
				});
		}
		return { ...draft, blocks: [{ ...block, weeks }, ...draft.blocks.slice(1)] };
	};
}
