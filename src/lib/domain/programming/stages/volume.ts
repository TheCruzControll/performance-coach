/**
 * Weekly hard sets per muscle group inside the goal’s range (../volume.ts), for the split the
 * strength stage chose: every block with weeks at full volume is balanced, the outline is not.
 * Runs after placement and before loads, progression and timefit, which checks every set again.
 */
import { demandIn } from '../stage.ts';
import type { Stage } from '../stage.ts';
import { chooseSplit } from '../splits.ts';
import { balanceBlock } from '../volume.ts';

export const volume: Stage = (draft, { input, log }) => {
	const share = demandIn(draft).allocation.streams.find((s) => s.stream === 'strength');
	if (!share?.generated) return draft;
	const split = chooseSplit(input, share.generated);
	return {
		...draft,
		blocks: draft.blocks.map((block, b) => balanceBlock(block, b, split, input, log))
	};
};
