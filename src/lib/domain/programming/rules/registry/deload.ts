/**
 * The deload rules (m7/17 deload-taper): the cadence by experience, a deload week's targets, the
 * reactive triggers over M6's signals and the guards that hold a deload back, with the functions
 * that apply them. The ids are the rule keys deloadNeed's outcomes cite.
 */
import { CADENCE, GUARDS, TARGETS, TRIGGERS } from '../deload.ts';
import type { RuleDefinition } from './types.ts';

const FILE = 'src/lib/domain/programming/rules/deload.ts';
const APPLY = 'src/lib/domain/programming/periodisation/deload.ts';

export const rules: readonly RuleDefinition[] = [
	{
		id: 'deload.cadence',
		kind: 'constant',
		statement:
			'A deload comes after 5 loading weeks for a new lifter, 4 for a novice or intermediate and 3 for an advanced one, and at the end of a block.',
		rationale: CADENCE.why,
		source: `${FILE}#CADENCE`,
		values: CADENCE
	},
	{
		id: 'deload.targets',
		kind: 'constant',
		statement:
			'A deload week has 40 % fewer sets at RPE 6 at most and loads 10 % lighter, runs 30 % shorter and all easy, and Muay Thai as technique with no sparring.',
		rationale: TARGETS.why,
		source: `${FILE}#TARGETS`,
		values: TARGETS
	},
	{
		id: 'deload.triggers',
		kind: 'constant',
		statement:
			'A deload is needed now when fatigue is high, when it is at watch with 2 or more main lifts really declining or easy runs 3 % slower at the same effort, or when a body system is overloaded on 5 of the last 7 days.',
		rationale: TRIGGERS.why,
		source: `${FILE}#TRIGGERS`,
		values: TRIGGERS
	},
	{
		id: 'deload.guards',
		kind: 'constant',
		statement:
			'A needed deload is not added to a week that is already light; it waits for a taper, event, recovery week or planned deload in the next two weeks; and within 14 days of the last deload it only trims volume.',
		rationale: GUARDS.why,
		source: `${FILE}#GUARDS`,
		values: GUARDS
	},
	{
		id: 'deload.scheduled',
		kind: 'behaviour',
		statement:
			'A block’s scheduled deloads follow the cadence, counting again after any light week already planned.',
		rationale:
			'A taper or event week already rests you, so the next deload is counted from it, never stacked beside it.',
		source: `${APPLY}#scheduledDeloads`
	},
	{
		id: 'deload.in_place',
		kind: 'behaviour',
		statement:
			'A deload changes only the values of the sessions still ahead in its week: the same sessions, days, exercises and set rows.',
		rationale:
			'A deload often starts after a week has begun, so what is done stays as it was and the rest of the week keeps its shape.',
		source: `${APPLY}#deloadSessions`
	}
];
