/**
 * Week 1's loads from the baselines (../loads.ts): each main lift of the baseline week, by RPE
 * where its 1RM is blank. The weeks after are the progression stage's. Every main lift of the
 * block gets one load_basis decision, from the first week it appears in, that says what its loads
 * come from and cites the 1RM when there is one.
 */
import { LIFT_LABEL } from '../../profile/catalog.ts';
import { percentOfOneRepMax } from '../../rpe.ts';
import type { BaselineLift, PlannedExercisePlan, WeekTargets } from '../../training/types.ts';
import { cleanFloat, formatWeight } from '../../units.ts';
import { toExerciseKey } from '../input.ts';
import type { ProgrammingInput } from '../input.ts';
import { eachMain, loadBaseline, topReps } from '../loads.ts';
import type { MainLift } from '../loads.ts';
import { knownShare } from '../progression.ts';
import { exerciseOf } from '../selection.ts';
import type { Stage } from '../stage.ts';

const percent = (share: number) => `${cleanFloat(share * 100, 1)} %`;

/**
 * What a load_basis decision says about a main lift first planned in the last of `weeks` (their
 * targets, the block's first week first); null when its reps are off M1's table, so it stays
 * RPE-based.
 */
export function basisFacts(
	planned: PlannedExercisePlan,
	{ lift, oneRepMax }: MainLift,
	weeks: readonly WeekTargets[],
	input: ProgrammingInput
) {
	const reps = topReps(planned);
	const { rpeCap } = weeks.at(-1)!;
	const table = reps === null ? null : percentOfOneRepMax(reps, rpeCap);
	if (reps === null || table === null) return null;
	const exercise = exerciseOf(input, toExerciseKey(planned.exercise))?.name ?? LIFT_LABEL[lift];
	const about = { exercise, lift, reps, rpe: rpeCap };
	if (!oneRepMax) {
		return {
			...about,
			basis: 'a baseline set by RPE',
			reason: `You have no 1RM for it yet, so its first session works up to a set of ${reps} at RPE ${rpeCap} and records it. That set estimates your 1RM, and every load after it is a share of your latest estimate.`
		};
	}
	const share = knownShare(reps, oneRepMax.kind, weeks);
	if (share === null) return null;
	const start = `It starts at ${percent(share)} for sets of ${reps}`;
	return {
		...about,
		oneRepMaxKg: oneRepMax.kg,
		share,
		basis: `your ${oneRepMax.kind} 1RM of ${formatWeight(oneRepMax.kg, 'kg', 1)}`,
		reason:
			oneRepMax.kind === 'measured'
				? `${start}, under the ${percent(table)} that RPE ${rpeCap} allows, so it begins comfortably even if your max has moved since you tested it.`
				: `An estimate is never treated as a tested max. ${start}, a step under a measured max, and each set is held to its RPE, so take weight off if one feels harder.`
	};
}

export const loads: Stage = (draft, { input, log }) => {
	const first = new Map<BaselineLift, Parameters<typeof basisFacts>>();
	const refs = new Map<BaselineLift, string>();
	const blocks = draft.blocks.map((block, b) => ({
		...block,
		weeks: block.weeks.map((week, w) => {
			const { rpeCap } = week.targets;
			const targets = block.weeks.slice(0, w + 1).map((x) => x.targets);
			return eachMain(week, input, (planned, main) => {
				if (!first.has(main.lift)) {
					first.set(main.lift, [planned, main, targets, input]);
					refs.set(main.lift, `blocks.${b}`);
				}
				return week.kind === 'baseline' ? loadBaseline(planned, main, rpeCap) : planned;
			});
		})
	}));
	for (const [lift, args] of first) {
		const facts = basisFacts(...args);
		const rule = input.baselines[lift]?.kind ?? 'baseline_set';
		if (facts) log.add('load_basis', `loads.${rule}`, [refs.get(lift)!], facts);
	}
	return { ...draft, blocks };
};
