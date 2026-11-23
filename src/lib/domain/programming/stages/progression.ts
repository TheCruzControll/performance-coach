/**
 * Weeks 2 to the deload, by the block’s progression rules (../progression.ts): every planned
 * block stores LOAD_RULES as its progression and has its weeks after the baseline built from
 * them. A block with strength sessions gets a progression decision for each of those weeks, so
 * the owner can read what changes from week to week and why.
 */
import type { WeekTargets } from '../../training/types.ts';
import type { Phase } from '../../training/vocabulary.ts';
import { loadSources, progressionFacts, progressWeeks } from '../progression.ts';
import { LOAD_RULES } from '../rules/loads.ts';
import type { Stage } from '../stage.ts';

/**
 * M7: a week its phase prescribes (mainLifts) names the phase, and its change starts with the main
 * lifts' reps (phasing's prescription).
 */
function phaseFacts({ mainLifts }: WeekTargets, change: string, phase: Phase) {
	if (!mainLifts) return null;
	const { repsMin, repsMax } = mainLifts;
	const reps = repsMin === repsMax ? `${repsMin}` : `${repsMin}–${repsMax}`;
	return { phase, change: `main lifts in sets of ${reps}, ${change}` };
}

export const progression: Stage = (draft, { input, log }) => {
	const blocks = draft.blocks.map((block, b) => {
		if (block.outline) return block;
		const weeks = progressWeeks(block.weeks, input, LOAD_RULES);
		if (weeks.some((week) => week.sessions.some((s) => s.kind === 'strength'))) {
			const sources = loadSources(weeks, input);
			weeks.forEach((week, w) => {
				if (week.kind === 'baseline') return;
				const facts = progressionFacts(week, w + 1, sources, LOAD_RULES);
				const phased = phaseFacts(week.targets, facts.change, block.phase);
				const ref = `blocks.${b}.weeks.${w}`;
				log.add('progression', `progression.${week.kind}`, [ref], { ...facts, ...phased });
			});
		}
		return { ...block, progression: { ...LOAD_RULES }, weeks };
	});
	return { ...draft, blocks };
};
