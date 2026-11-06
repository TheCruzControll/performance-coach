/**
 * Every generated session fitted to the session length (../timefit.ts); the last stage, so every
 * set the stages before it added is checked again. Sessions trimmed alike share one time_trimmed
 * decision that names each of them.
 */
import type { PlanPath } from '../../training/types.ts';
import type { Stage } from '../stage.ts';
import { fitWeek } from '../timefit.ts';
import type { Trim } from '../timefit.ts';

/** A decision names at most this many plan paths (programPlanSchema). */
const MAX_REFS = 50;

export const timefit: Stage = (draft, { input, log }) => {
	const trims = new Map<string, { facts: Trim['facts']; refs: PlanPath[] }>();
	const blocks = draft.blocks.map((block, b) => ({
		...block,
		weeks: block.weeks.map((week, w) => {
			const fitted = fitWeek(week, input);
			for (const { index, facts } of fitted.trims) {
				const id = JSON.stringify(facts);
				const trim = trims.get(id) ?? { facts, refs: [] };
				trim.refs.push(`blocks.${b}.weeks.${w}.sessions.${index}`);
				trims.set(id, trim);
			}
			return fitted.week;
		})
	}));
	for (const { facts, refs } of trims.values()) {
		for (let i = 0; i < refs.length; i += MAX_REFS) {
			log.add('time_trimmed', 'timefit.session_minutes', refs.slice(i, i + MAX_REFS), facts);
		}
	}
	return { ...draft, blocks };
};
