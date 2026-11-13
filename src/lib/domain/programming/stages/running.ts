/**
 * Easy runs, the long run and any quality session, from the current volume (../running.ts),
 * around the running commitments already placed; then, with a bike, some easy runs become zone 2
 * bike sessions (../cross-training.ts), so every later stage sees them as they are.
 */
import { planZone2Bike } from '../cross-training.ts';
import { planRuns } from '../running.ts';
import { demandIn } from '../stage.ts';
import type { Stage } from '../stage.ts';

export const running: Stage = (draft, { input, options, log }) => {
	const demand = demandIn(draft);
	const runs = planRuns(draft.blocks, demand, input, options, log);
	return { ...draft, blocks: planZone2Bike(runs, demand, input, options, log) };
};
