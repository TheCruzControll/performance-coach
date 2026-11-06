/**
 * Weeks 2 to the deload, by the block’s progression rules (../progression.ts): every planned
 * block stores LOAD_RULES as its progression and has its weeks after the baseline built from
 * them. A block with strength sessions gets a progression decision for each of those weeks, so
 * the owner can read what changes from week to week and why.
 */
import { loadSources, progressionFacts, progressWeeks } from '../progression.ts';
import { LOAD_RULES } from '../rules/loads.ts';
import type { Stage } from '../stage.ts';

export const progression: Stage = (draft, { input, log }) => {
	const blocks = draft.blocks.map((block, b) => {
		if (block.outline) return block;
		const weeks = progressWeeks(block.weeks, input, LOAD_RULES);
		if (weeks.some((week) => week.sessions.some((s) => s.kind === 'strength'))) {
			const sources = loadSources(weeks, input);
			weeks.forEach((week, w) => {
				if (week.kind === 'baseline') return;
				const facts = progressionFacts(week, w + 1, sources, LOAD_RULES);
				log.add('progression', `progression.${week.kind}`, [`blocks.${b}.weeks.${w}`], facts);
			});
		}
		return { ...block, progression: { ...LOAD_RULES }, weeks };
	});
	return { ...draft, blocks };
};
