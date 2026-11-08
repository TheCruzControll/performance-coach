/**
 * M7's goal priorities and maintenance doses (goal-priorities and maintenance-doses reword it).
 * `reason` and `modes` are whole sentences: the rule that decided, and every other goal's mode.
 */
import type { Templates } from '../../decisions.ts';

export const periodisationGoals = {
	priority_resolved: {
		summary: '{leader} leads from {from}',
		why: '{leader} leads from {from} to {until}. {reason} {modes}'
	},
	maintenance_dose: {
		summary: '{goal} held at maintenance',
		why: '{goal} is held at its maintenance dose while {leader} leads: {dose}. {reason}'
	}
} as const satisfies Templates;
