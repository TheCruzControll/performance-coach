/**
 * The priority rules (goal-priorities): who leads on a date, who trains alongside the leader and
 * who is held at maintenance. The ids are the rule keys priority/weights.ts cites.
 */
import {
	ALL_PAUSED,
	CONFLICTS,
	LEAD,
	LEAD_WEEKS,
	RANK_WEIGHTS,
	SECONDARY_SHARE
} from '../priority.ts';
import type { RuleDefinition } from './types.ts';

const FILE = 'src/lib/domain/programming/rules/priority.ts';

export const rules: readonly RuleDefinition[] = [
	{
		id: 'priority.rank_weights',
		kind: 'constant',
		statement:
			'Goals weigh 1, 0.6, 0.4, 0.25 and 0.15 by their place on a date, the leader first; with no event near, your ranking sets the places.',
		rationale:
			'A clash that harms a goal costs that goal’s weight, so the leader’s sessions are protected first and a low-ranked goal gives way.',
		source: `${FILE}#RANK_WEIGHTS`,
		values: RANK_WEIGHTS
	},
	{
		id: 'priority.lead_weeks',
		kind: 'constant',
		statement:
			'An event takes the lead this many weeks before it: a fight 8, a marathon 16, a half marathon 12, a meet 10 and any other race 6.',
		rationale:
			'Each is about the length of that event’s specific preparation; set to 0, an event never leads early and your ranking always wins.',
		source: `${FILE}#LEAD_WEEKS`,
		values: LEAD_WEEKS
	},
	{
		id: 'priority.lead',
		kind: 'constant',
		statement:
			'Inside its lead window, an event goal leads over every goal whose own event is outside its window. Two in-window events go by rank, and a passed event drops out.',
		rationale:
			'An event has a date that will not move, so its preparation cannot wait; once it has passed, your ranking decides again.',
		source: `${FILE}#LEAD`,
		values: LEAD
	},
	{
		id: 'priority.secondary_share',
		kind: 'constant',
		statement:
			'A goal with at least half the leader’s weight that does not conflict with it trains alongside as secondary; every other goal is held at maintenance.',
		rationale:
			'Recovery is shared: two goals can progress together only when both carry real weight and do not pull against each other.',
		source: `${FILE}#SECONDARY_SHARE`,
		values: SECONDARY_SHARE
	},
	{
		id: 'priority.conflicts',
		kind: 'constant',
		statement:
			'Fight camp and a marathon build or peak hold a muscle-building goal at maintenance, a marathon peak and taper hold strength, and meet prep holds muscle building.',
		rationale:
			'Each pair asks for opposite adaptations or the same recovery, so only the leader progresses while the other is kept.',
		source: `${FILE}#CONFLICTS`,
		values: CONFLICTS
	},
	{
		id: 'priority.all_paused',
		kind: 'constant',
		statement: 'With every open goal paused, each is kept at maintenance and none leads.',
		rationale:
			'Pausing everything is a break, not a stop: the program keeps what you have built until you resume a goal.',
		source: `${FILE}#ALL_PAUSED`,
		values: ALL_PAUSED
	}
];
