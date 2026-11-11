/**
 * What runs before the stages (m7-stage-list), in M3's generator and M6's next block alike: it
 * returns the input every stage reads and the periodisation the draft starts with. For now it is
 * the identity, with no periodisation: M7's generator-season slice makes it reorder the goals by
 * their effective priority at the block's start and plan the season. The title and the stored
 * input snapshot always keep the original input.
 */
import type { DecisionLog } from '../decisions.ts';
import type { ProgrammingInput } from '../input.ts';
import type { GenerateOptions, Periodisation } from '../stage.ts';

export interface Prepared {
	/** The input the stages read. */
	input: ProgrammingInput;
	/** The draft's periodisation; null while none is planned. */
	periodisation: Periodisation | null;
}

export function prepare(
	input: ProgrammingInput,
	_options: GenerateOptions,
	_log: DecisionLog
): Prepared {
	return { input, periodisation: null };
}
