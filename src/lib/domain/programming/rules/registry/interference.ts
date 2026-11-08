/**
 * M3's interference rules (m7-contract): the thresholds, the four rules placement and the move
 * edit check, placement's own judgement calls and whether a broken rule blocks an edit. The ids
 * of the four rules are the keys placement's interference_resolved decisions cite.
 */
import { BLOCKS_EDIT, INTERFERENCE, INTERFERENCE_RULES } from '../../interference.ts';
import type { InterferenceRule } from '../../interference.ts';
import { PLACEMENT } from '../../placement.ts';
import type { RuleDefinition } from './types.ts';

const FILE = 'src/lib/domain/programming/interference.ts';

const STATEMENTS: Readonly<Record<InterferenceRule, string>> = {
	heavy_lower_before_hard:
		'No heavy lower-body session the day before hard Muay Thai or a long run.',
	intervals_after_very_demanding: 'No intervals the day after a very demanding day.',
	hard_days_apart:
		'Hard days sit apart, with an easier day between, when the week has room to space them.',
	same_day_order:
		'When one day holds both, the session that needs fresh legs comes first: Muay Thai, the long run or the intervals before the lifting.'
};

const checks = Object.keys(INTERFERENCE_RULES).map((rule): RuleDefinition => {
	const data = INTERFERENCE_RULES[rule as InterferenceRule];
	return {
		id: `placement.${rule}`,
		kind: 'constant',
		statement: STATEMENTS[rule as InterferenceRule],
		rationale: data.why,
		severity: data.severity,
		source: `${FILE}#INTERFERENCE_RULES.${rule}`,
		values: data
	};
});

export const rules: readonly RuleDefinition[] = [
	{
		id: 'interference.thresholds',
		kind: 'constant',
		statement:
			'What a session asks of the body: a heavy set is RPE 8 or 80 % of a 1RM on a compound lift, 10 hard sets for a region is high volume, a long run is 90 minutes, and sparring is always hard.',
		rationale:
			'Each threshold is a judgement call M3 made and M7 tunes as data: these are the sessions that leave the legs or the upper body tired the next day.',
		source: `${FILE}#INTERFERENCE`,
		values: INTERFERENCE
	},
	...checks,
	{
		id: 'interference.blocks_edit',
		kind: 'constant',
		statement:
			'A move of yours that breaks an interference rule goes ahead, with its warning shown and recorded.',
		rationale:
			'The week is yours: the rules advise, and the decision records the trade-off you chose (m3-plan open question on moves).',
		source: `${FILE}#BLOCKS_EDIT`,
		values: BLOCKS_EDIT
	},
	{
		id: 'placement.order',
		kind: 'constant',
		statement:
			'Commitments keep their days; then the long run, hard Muay Thai, heavy lower body, other strength, the quality run, easy runs, other sessions and mobility take theirs, the long run on the weekend first.',
		rationale:
			'The most demanding sessions are hardest to fit around the rest, and strength is placed as its hardest week makes it, so a session keeps its day all block.',
		source: 'src/lib/domain/programming/placement.ts#PLACEMENT',
		values: PLACEMENT
	}
];
