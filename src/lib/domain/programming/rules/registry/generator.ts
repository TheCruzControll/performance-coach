/**
 * The generator's rules: the serial generator chain (m7/28 generator-season to m7/33
 * generator-combat) appends to this file, each slice its own entries.
 *
 * generator-season (m7/28): the season, the goal order and modes, and the dose caps, each a
 * behaviour applied by the function its source names.
 */
import type { RuleDefinition } from './types.ts';

const PROGRAMMING = 'src/lib/domain/programming';

export const rules: readonly RuleDefinition[] = [
	{
		id: 'generator.priority_order',
		kind: 'behaviour',
		statement:
			'Before any stage runs, the goals are put in order of their effective priority on the block’s first day, the leader first, and each is marked primary, secondary or held at maintenance.',
		rationale:
			'The day rule, the split and the placement all favour the first goal, so putting the goal that leads now first makes every one of them follow it without changing their own rules.',
		source: `${PROGRAMMING}/stages/prepare.ts#prepare`
	},
	{
		id: 'generator.season_blocks',
		kind: 'behaviour',
		statement:
			'A new program holds the season’s blocks: the first planned week by week, then outlines to each event, with every block type, taper, deload and dose recorded. With every goal paused, it is the maintenance plan as before.',
		rationale:
			'Planning the whole road at once shows where each block leads, and the first block is the only one planned in detail because the rest are planned from your results when they come up.',
		source: `${PROGRAMMING}/stages/blocks.ts#blocks`
	},
	{
		id: 'generator.secondary_split',
		kind: 'behaviour',
		statement:
			'A strength or muscle-building goal training alongside the leader as a secondary goal keeps its own split and style, even when another kind of goal leads.',
		rationale:
			'A secondary goal is still meant to progress, which the maintenance split cannot do; only a goal held at maintenance moves to it.',
		source: `${PROGRAMMING}/splits.ts#chooseSplit`
	},
	{
		id: 'generator.dose_cap',
		kind: 'behaviour',
		statement:
			'A kind of session that only goals held at maintenance want gets no more sessions a week than their dose, and the days it frees go round again, the leader first.',
		rationale:
			'A dose is the least that keeps a goal; giving it more days would take them from the goal that leads now.',
		source: `${PROGRAMMING}/demand.ts#allocateWeek`
	}
];

/**
 * M3's block rules that M7 replaces once no generation path reads their constant. None is marked
 * yet: on m7/28, TAPER_LEAD_DAYS is still read by periodisation/fight-camp.ts and rules/taper.ts,
 * FIRST_BLOCK by review/directives.ts (M6's next-block dates) and rules/road.ts, and
 * SHORT_EVENT_WEEKS by blocks.ts planFirstBlock, which the season keeps for a first program and the
 * all-paused plan. The slice that removes the last reader adds the entry here.
 */
export const supersedes: Readonly<Record<string, string>> = {};
