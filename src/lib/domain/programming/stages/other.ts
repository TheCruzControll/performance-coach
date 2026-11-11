/**
 * Muay Thai, mobility and custom-discipline sessions with their details and metrics
 * (../other.ts), after the runs.
 */
import { planOther } from '../other.ts';
import { demandIn } from '../stage.ts';
import type { Stage } from '../stage.ts';

export const other: Stage = (draft, { input, options, log }) => ({
	...draft,
	blocks: planOther(
		draft.blocks,
		demandIn(draft),
		input,
		options,
		log,
		draft.periodisation?.dosesByWeek
	)
});
