/**
 * The replan rules (m7/40 replan-domain): where a re-plan starts, each mechanism, when a deload
 * keeps M6's path, what a regenerated week replaces and the refusals, with the function that
 * applies them. The mechanism ids are the rule keys periodisation/replan.ts's replanned decisions cite.
 */
import { DELOAD_HOLD, MECHANISMS, REFUSALS, REPLAN_SCOPE, REPLAN_START } from '../replan.ts';
import type { ReplanMechanism } from '../replan.ts';
import type { RuleDefinition } from './types.ts';

const FILE = 'src/lib/domain/programming/rules/replan.ts';
const ENGINE = 'src/lib/domain/programming/periodisation/replan.ts';

const mechanism = (id: ReplanMechanism, statement: string): RuleDefinition => ({
	id: `replan.${id}`,
	kind: 'constant',
	statement,
	rationale: MECHANISMS[id].why,
	source: `${FILE}#MECHANISMS.${id}`,
	values: MECHANISMS[id]
});

export const rules: readonly RuleDefinition[] = [
	{
		id: 'replan.start',
		kind: 'constant',
		statement:
			'A re-plan for new priorities, a chosen block or a taper starts on the next Monday (today on a Monday) with nothing logged or skipped from it.',
		rationale: REPLAN_START.why,
		source: `${FILE}#REPLAN_START`,
		values: REPLAN_START
	},
	mechanism(
		'regenerate',
		'New priorities or a chosen block plan the weeks from the start again, cutting a block running across it and replacing one starting there, keeping every exercise still allowed and rotating none.'
	),
	mechanism(
		'splice',
		'A taper replaces the weeks before its event with the same sessions at less volume, and every block after the event is kept.'
	),
	mechanism(
		'in_place',
		'A deload changes only the values of its week’s sessions still ahead, and the week becomes a deload week.'
	),
	{
		id: 'replan.deload_hold',
		kind: 'constant',
		statement:
			'A deload waits when a deload, taper, event or recovery week falls in its week or the two after, and the owner or coach may deload only this week or next.',
		rationale: DELOAD_HOLD.why,
		source: `${FILE}#DELOAD_HOLD`,
		values: DELOAD_HOLD
	},
	{
		id: 'replan.scope',
		kind: 'constant',
		statement:
			'A regenerated week places its sessions afresh, replacing your own moves in it, and the proposal lists each one.',
		rationale: REPLAN_SCOPE.why,
		source: `${FILE}#REPLAN_SCOPE`,
		values: REPLAN_SCOPE
	},
	{
		id: 'replan.refusals',
		kind: 'constant',
		statement:
			'A re-plan is refused when the event is too close, the change does not apply, a block works against the main event, the plan holds too many blocks, or nothing is left ahead.',
		rationale: REFUSALS.why,
		source: `${FILE}#REFUSALS`,
		values: REFUSALS
	},
	{
		id: 'replan.apply',
		kind: 'behaviour',
		statement:
			'Each re-plan is one new version: the past and every event date stay, and the new weeks are checked against the plan contract.',
		rationale:
			'A version you can compare and go back to is how every change to your plan is kept, so a re-plan is never an edit you cannot see.',
		source: `${ENGINE}#generateReplan`
	}
];
