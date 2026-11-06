/**
 * Fixed commitments as sessions on their own weekdays, each counted toward its quota
 * (../commitments.ts). It runs right after the blocks, so every later stage plans around them.
 */
import { placeCommitments } from '../commitments.ts';
import { demandIn } from '../stage.ts';
import type { Stage } from '../stage.ts';

export const commitments: Stage = (draft, { input, options, log }) => ({
	...draft,
	blocks: placeCommitments(draft.blocks, demandIn(draft), input, options, log)
});
