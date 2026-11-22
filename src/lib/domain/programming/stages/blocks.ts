/**
 * The first block's weeks and the outline after it (../blocks.ts), from week 1's Monday: the
 * skeleton every later stage fills. M6's next block replaces this stage with nextShape.
 */
import { planFirstBlock } from '../blocks.ts';
import type { Stage } from '../stage.ts';

export const blocks: Stage = (draft, { input, options, log }) => ({
	...draft,
	blocks: planFirstBlock(input, options.startsOn, log)
});
