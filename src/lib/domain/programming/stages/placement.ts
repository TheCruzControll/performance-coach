/**
 * Every session on its day and time of day, by the concurrent-training rules and goal priority
 * (../placement.ts), once every session of the week is planned and before volume, loads and the
 * time fit fill them in.
 */
import { placeSessions } from '../placement.ts';
import { demandIn } from '../stage.ts';
import type { Stage } from '../stage.ts';

export const placement: Stage = (draft, { input, options, log }) => ({
	...draft,
	blocks: placeSessions(draft.blocks, demandIn(draft), input, options, log)
});
