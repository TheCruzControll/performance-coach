/**
 * The road rules (m7/27 season-road): block lengths, the horizon, each window's outline phases,
 * a first program's start, the taper guard on deloads, the plan budget and the decision grain,
 * each with its live constant, and the functions that plan the season and store its blocks. The
 * ids are the rule keys periodisation/season.ts cites.
 */
import {
	BLOCK_LENGTH,
	DECISION_GRAIN,
	FIRST_PROGRAM,
	HORIZON,
	OUTLINE_PHASES,
	PLAN_BUDGET,
	TAPER_GUARD
} from '../road.ts';
import type { RuleDefinition } from './types.ts';

const FILE = 'src/lib/domain/programming/rules/road.ts';
const SEASON = 'src/lib/domain/programming/periodisation/season.ts';

const constant = (
	id: string,
	name: string,
	values: { why: string },
	statement: string
): RuleDefinition => ({
	id: `road.${id}`,
	kind: 'constant',
	statement,
	rationale: values.why,
	source: `${FILE}#${name}`,
	values
});

export const rules: readonly RuleDefinition[] = [
	constant(
		'block_length',
		'BLOCK_LENGTH',
		BLOCK_LENGTH,
		'A first program’s first block is 5 weeks wherever M7 has no rule of its own, as M3’s first block is, and no planned block holds more than 52 weeks.'
	),
	constant(
		'horizon',
		'HORIZON',
		HORIZON,
		'The road runs to the last dated goal’s event, its recovery and 4 weeks after, or its target date: at least 12 weeks ahead and at most 52.'
	),
	constant(
		'outline_phases',
		'OUTLINE_PHASES',
		OUTLINE_PHASES,
		'An outline lays each run-up out phase by phase, the fixed phases counted back from the event and the earliest taking the weeks left: a marathon’s peak and taper 3 weeks each, a half’s 2, a shorter race’s peak 2 and taper 1.'
	),
	constant(
		'first_program',
		'FIRST_PROGRAM',
		FIRST_PROGRAM,
		'Only a first program starts with a baseline week, at RPE 7 at most; where its first window is a block between events, the gap before the first run-up or a marathon base, the first block and the road to the next event are M3’s.'
	),
	constant(
		'taper_guard',
		'TAPER_GUARD',
		TAPER_GUARD,
		'No scheduled deload falls within 3 weeks before a taper or an event week.'
	),
	constant(
		'plan_budget',
		'PLAN_BUDGET',
		PLAN_BUDGET,
		'A plan holds at most 10 blocks, counting the past blocks it keeps, and 300 decisions; far outlines merge into one per event and then one to the horizon, and a plan whose past blocks leave no room is refused with too_many_blocks.'
	),
	constant(
		'decision_grain',
		'DECISION_GRAIN',
		DECISION_GRAIN,
		'Volume, long-run, sparring and maintenance-dose decisions are one per block with the week ramp in their evidence; a repaired schedule is one per block for shared moves and one per week only for a week repaired on its own.'
	),
	{
		id: 'road.season',
		kind: 'behaviour',
		statement:
			'The season’s windows become dated blocks: the first planned with its weeks, deloads and taper, the rest outlines ending on event Sundays.',
		rationale:
			'One road from today to the last event keeps every block pointed at what you are training for, and planning only the next block in full lets it adapt to how training goes.',
		source: `${SEASON}#planSeason`
	},
	{
		id: 'road.block_plans',
		kind: 'behaviour',
		statement:
			'The season’s blocks are stored as the plan’s blocks: dated weeks with their targets, outlines with none, and no sessions until the generator fills them.',
		rationale:
			'The plan, Train and the coach read one stored shape, so a season block reads like any other block.',
		source: `${SEASON}#toBlockPlans`
	}
];
