/**
 * The load rules (m7/06 load-systems): how a session's sRPE splits across the five body systems,
 * the RPE a planned session with no target is estimated at, and M6's rule for unknown load.
 */
import { DEFAULT_RPE, SYSTEM_SHARES } from '../load.ts';
import type { RuleDefinition } from './types.ts';

const FILE = 'src/lib/domain/programming/rules/load.ts';

export const rules: readonly RuleDefinition[] = [
	{
		id: 'load.system_shares',
		kind: 'constant',
		statement:
			'A session’s load (minutes × RPE) splits across lower body, upper body, aerobic, combat and the nervous system by its type: lifting by where its hard sets are, runs by their impact, Muay Thai by its format.',
		rationale:
			'Each system recovers on its own, so a heavy squat day and a long run tire different things. The weights are coaching judgements, each with its reason, and a session’s shares always add to 1.',
		source: `${FILE}#SYSTEM_SHARES`,
		values: SYSTEM_SHARES
	},
	{
		id: 'load.default_rpe',
		kind: 'constant',
		statement:
			'A planned session with no target RPE is estimated at a typical RPE for its type, and that load is kept as its own estimated series.',
		rationale:
			'A guess is better than no load for planning, but it is never mixed with load the plan or your logs actually give.',
		source: `${FILE}#DEFAULT_RPE`,
		values: DEFAULT_RPE
	},
	{
		id: 'load.unknown',
		kind: 'behaviour',
		statement:
			'A logged session with no RPE or no duration has an unknown load: it is counted and named, and left out of every total, never taken as 0.',
		rationale:
			'Progress and the weekly review count load the same way (M6), so Train and the coach never disagree with them, and a missing RPE never looks like a rest day.',
		source: 'src/lib/domain/programming/load/systems.ts#systemLoads'
	}
];
