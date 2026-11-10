/**
 * The maintenance rules (m7/16 maintenance-doses): each stream's dose, a secondary goal's band and
 * the maintenance block. The ids are the rule keys a maintenance_dose decision cites.
 */
import { DOSES, MAINTENANCE_BLOCK, SECONDARY } from '../maintenance.ts';
import type { DoseStream } from '../maintenance.ts';
import type { RuleDefinition } from './types.ts';

const FILE = 'src/lib/domain/programming/rules/maintenance.ts';

const dose = (stream: DoseStream, statement: string): RuleDefinition => ({
	id: `maintenance.${stream}`,
	kind: 'constant',
	statement,
	rationale: DOSES[stream].why,
	source: `${FILE}#DOSES.${stream}`,
	values: DOSES[stream]
});

export const rules: readonly RuleDefinition[] = [
	dose(
		'strength',
		'Strength held at maintenance is the maintenance split: 1–2 Keep sessions, 2 sets a slot, 4–10 hard sets a major group, with the main lifts’ top set at RPE 8 at most.'
	),
	dose(
		'hypertrophy',
		'Muscle building held at maintenance is the same maintenance split: 1–2 Keep sessions, 2 sets a slot, 4–10 hard sets a major group, top sets at RPE 8 at most.'
	),
	dose(
		'runs',
		'Running held at maintenance is 2–3 runs at 60–70 % of your recent weekly volume, one quality run at most, and the long run held at your recent longest.'
	),
	dose(
		'muay_thai',
		'Muay Thai held at maintenance is 1–2 technique or pad sessions, with no sparring unless it is a class you attend.'
	),
	dose('custom', 'Your own discipline held at maintenance is one session a week.'),
	{
		id: 'maintenance.secondary',
		kind: 'constant',
		statement:
			'A secondary strength or muscle-building goal keeps its own split and style, at the lower half of its usual hard sets: 8–11 a group for strength, 10–15 for muscle.',
		rationale: SECONDARY.why,
		source: `${FILE}#SECONDARY`,
		values: SECONDARY
	},
	{
		id: 'maintenance.block',
		kind: 'constant',
		statement:
			'A maintenance block holds every goal at its dose for 4–8 weeks, every week a maintenance week, with no scheduled deload.',
		rationale: MAINTENANCE_BLOCK.why,
		source: `${FILE}#MAINTENANCE_BLOCK`,
		values: MAINTENANCE_BLOCK
	}
];
