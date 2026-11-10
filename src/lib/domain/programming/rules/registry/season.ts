/**
 * The season rules (m7/26 season-windows): each event's window, overlaps resolved by rank,
 * recovery, the fill between windows, the short lead-in and the three maintenance cases, each with
 * its live constant, and the function that lays out the season. The ids are the rule keys
 * periodisation/windows.ts cites.
 */
import { FILL, LEAD_IN, MAINTENANCE, OVERLAP, RECOVERY, WINDOW } from '../season.ts';
import type { RuleDefinition } from './types.ts';

const FILE = 'src/lib/domain/programming/rules/season.ts';

const constant = (
	id: string,
	name: string,
	values: { why: string },
	statement: string
): RuleDefinition => ({
	id: `season.${id}`,
	kind: 'constant',
	statement,
	rationale: values.why,
	source: `${FILE}#${name}`,
	values
});

export const rules: readonly RuleDefinition[] = [
	constant(
		'window',
		'WINDOW',
		WINDOW,
		'Each event leads its run-up: 8 weeks for a fight, 16 for a marathon, 12 for a half, 10 for a meet and 6 for a shorter race, its own week included; a run-up under 3 weeks, or no longer than its taper, is only the taper.'
	),
	constant(
		'overlap',
		'OVERLAP',
		OVERLAP,
		'Where two run-ups overlap, the event you rank higher keeps its weeks, peak and taper; the other goal is held at maintenance through the overlap, and its event gets a 3-day mini-taper, or is trained through rather than taper twice in one week.'
	),
	constant(
		'recovery',
		'RECOVERY',
		RECOVERY,
		'A recovery week follows a fight, and two follow a marathon, before the next block builds.'
	),
	constant(
		'fill',
		'FILL',
		FILL,
		'Between run-ups, your top-ranked goal without an event date leads, in its block type: muscle building or strength, or a general accumulation block; a goal to keep, maintain or hold never leads one.'
	),
	constant(
		'lead_in',
		'LEAD_IN',
		LEAD_IN,
		'When fewer than 4 weeks come before the first run-up and its event already leads, the run-up starts on the first day.'
	),
	constant(
		'maintenance.paused',
		'MAINTENANCE.paused',
		MAINTENANCE.paused,
		'With every goal paused, the whole season is one maintenance block over the paused goals, with no leader.'
	),
	constant(
		'maintenance.short_gap',
		'MAINTENANCE.shortGap',
		MAINTENANCE.shortGap,
		'A gap of under 4 weeks between a recovery and the next run-up is a maintenance block.'
	),
	constant(
		'maintenance.no_building_goal',
		'MAINTENANCE.noBuildingGoal',
		MAINTENANCE.noBuildingGoal,
		'When no goal without an event date wants a building block, after the last event or in an off-season of keep goals, the season is a maintenance block.'
	),
	{
		id: 'season.windows',
		kind: 'behaviour',
		statement:
			'The season is laid out as windows from its first Monday: run-ups by rank, recovery, the fill between them and maintenance blocks, each with every goal’s mode and dose.',
		rationale:
			'One layout decides who leads every week of the season, so the plan, the coach and the reviews explain the same priorities.',
		source: 'src/lib/domain/programming/periodisation/windows.ts#seasonWindows'
	}
];
