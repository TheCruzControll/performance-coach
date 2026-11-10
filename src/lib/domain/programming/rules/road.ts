/**
 * The season's road (M7, PRD §5): how the season's windows become dated blocks, how far ahead the
 * road runs, and the budget that keeps every plan inside programPlanSchema with room for later
 * re-plans. periodisation/season.ts applies these; the rules registry (registry/road.ts) lists
 * each with its why. Every number is a default the owner can change in one line here (m7-plan open
 * questions on the plan's block cap and the deload cadence).
 */
import type { DecisionKind, Phase } from '../../training/vocabulary.ts';
import { FIRST_BLOCK, OUTLINES } from './blocks.ts';
import { MAINTENANCE_BLOCK } from './maintenance.ts';
import { MEET_SEQUENCE } from './strength-phases.ts';

/**
 * Block lengths: the first block of a first program is M3's FIRST_BLOCK long wherever M7 has no
 * rule of its own (a maintenance block of every paused goal included), and a planned block never
 * holds more weeks than programPlanSchema lets a block hold.
 */
export const BLOCK_LENGTH = {
	first: FIRST_BLOCK.length,
	maxPlanned: 52,
	why: 'Five weeks, a baseline, three that build and a deload, is the start the plan has always made, so a first program only changes where M7 has a reason to; no block plans more than a year of weeks.'
} as const;

/**
 * How far the road runs: to the Sunday after the last dated goal (its event, the recovery after it
 * and `tailWeeks` more, or its target date), never less than `minWeeks` and never more than
 * `maxWeeks` weeks.
 */
export const HORIZON = {
	minWeeks: 12,
	maxWeeks: 52,
	tailWeeks: MAINTENANCE_BLOCK.weeks.min,
	why: 'A quarter ahead shows where the next blocks lead even with no date set, and the shortest block after the last event’s recovery shows where training goes next; past a year the road is guesswork, and every block is planned in full when it comes up anyway.'
} as const;

/**
 * The phases an outline holds for a window of each kind, with their weeks: the fixed ones are kept
 * from the window's end backwards, and `null` takes the weeks left (M3's OUTLINES, a half on its
 * own half_* phases). A strength block between events builds like a meet run-up without the meet.
 * A meet's run-up is MEET_SEQUENCE's own (periodisation/strength.ts meetSequence).
 */
export const OUTLINE_PHASES = {
	marathon: OUTLINES.marathon,
	half: OUTLINES.half.map(([phase, weeks]) => [
		phase.replace('marathon_', 'half_') as Phase,
		weeks
	]),
	other: OUTLINES.event,
	strength: [
		['accumulation', null],
		['intensification', MEET_SEQUENCE.weeks.intensification],
		['realization', MEET_SEQUENCE.weeks.realization]
	],
	why: 'Each phase of a run-up keeps its usual length counted back from the event, so the peak and the taper land where they should; the earliest phase absorbs a longer or shorter run-up.'
} as const satisfies Record<
	'marathon' | 'half' | 'other' | 'strength',
	readonly (readonly [Phase, number | null])[]
> & { why: string };

/**
 * A first program (no history, no current phase) starts with a baseline week, capped at RPE 7,
 * where its block builds. Where the first window is one M7 plans no differently (a block between
 * events, the gap before the first run-up, or a marathon's base), the first block and the road to
 * the next event are M3's planFirstBlock, unchanged (periodisation/season.ts planSeason's `kept`;
 * a building fill other than hypertrophy).
 */
export const FIRST_PROGRAM = {
	baselineRpeCap: 7,
	why: 'Week 1 of a first program establishes your numbers, so nothing in it goes hard; where M7 adds no rule of its own the first block stays the one the plan has always made.'
} as const;

/** No scheduled deload falls within `weeksBefore` weeks before a taper or an event week. */
export const TAPER_GUARD = {
	weeksBefore: 3,
	why: 'A deload just before a taper is two light stretches in a row, which costs fitness for no extra freshness, so the taper is the rest.'
} as const;

/**
 * The budget every plan stays inside, well under programPlanSchema's 12 blocks and 500 decisions,
 * so later re-plans and next blocks still fit. The blocks count the past blocks a version keeps.
 * When the road has more blocks than the budget leaves, its outlines merge, in `merges` order:
 * - `events`: past the next event's run-up, one outline per event, then one to the horizon
 * - `per_event`: after the first block, one outline per event, then one to the horizon
 * - `horizon`: after the first block, one outline to the horizon
 * - `first_only`: the first block alone
 * When the past blocks leave no room even for the first block, the plan is refused. `decisions` is
 * bounded by the road's shape rather than checked: a few decisions per window and per planned
 * block, about 25 for the longest season, far under it even with a past version's decisions kept.
 */
export const PLAN_BUDGET = {
	blocks: 10,
	decisions: 300,
	schema: { blocks: 12, decisions: 500 },
	merges: ['events', 'per_event', 'horizon', 'first_only'],
	refusal: 'too_many_blocks',
	why: 'A plan keeps its past blocks, so each re-plan adds to the count: stopping at 10 of the 12 a plan can hold, and 300 of 500 decisions, leaves room for the next re-plan without ever producing a plan the store would refuse.'
} as const;

/**
 * Week-by-week facts are one decision per block, with the week ramp in its evidence. A repaired
 * schedule is one decision per block for the moves its building weeks share, and one per week
 * only for a week repaired on its own.
 */
export const DECISION_GRAIN = {
	perBlock: ['volume_progressed', 'long_run_progressed', 'sparring_load', 'maintenance_dose'],
	scheduleRepaired: { perBlock: 'shared_moves', perWeek: 'own_moves' },
	why: 'One sentence per block tells the story of a ramp; one per week would bury it and spend the plan’s decision budget on repeats.'
} as const satisfies {
	perBlock: readonly DecisionKind[];
	scheduleRepaired: Record<'perBlock' | 'perWeek', string>;
	why: string;
};
