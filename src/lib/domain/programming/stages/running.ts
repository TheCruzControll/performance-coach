/**
 * Easy runs, the long run and any quality session, from the current volume (../running.ts),
 * around the running commitments already placed.
 */
import { planRuns } from '../running.ts';
import { demandIn } from '../stage.ts';
import type { Stage } from '../stage.ts';

export const running: Stage = (draft, { input, options, log }) => ({
	...draft,
	blocks: planRuns(draft.blocks, demandIn(draft), input, options, log)
});
