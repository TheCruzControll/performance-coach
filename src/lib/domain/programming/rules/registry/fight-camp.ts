/**
 * The fight-camp rules (m7/19 fight-camp): the camp's length, its Muay Thai, hard sparring and
 * its cut-off, conditioning, strength, the fight week and weight cutting (out of scope), each with
 * its live constant, and the function that plans the camp.
 */
import {
	CAMP_WEEKS,
	CONDITIONING,
	FIGHT_WEEK,
	HARD_SPARRING,
	LAST_HARD_SPARRING,
	MUAY_THAI_SESSIONS,
	STRENGTH,
	WEIGHT_CUT
} from '../fight-camp.ts';
import type { RuleDefinition } from './types.ts';

const FILE = 'src/lib/domain/programming/rules/fight-camp.ts';

const constant = (
	id: string,
	name: string,
	values: { why: string },
	statement: string
): RuleDefinition => ({
	id: `fight_camp.${id}`,
	kind: 'constant',
	statement,
	rationale: values.why,
	source: `${FILE}#${name}`,
	values
});

export const rules: readonly RuleDefinition[] = [
	constant(
		'camp_weeks',
		'CAMP_WEEKS',
		CAMP_WEEKS,
		'A fight camp runs 6 to 8 weeks, the fight week included: 6 for a new or novice fighter, 7 intermediate and 8 advanced; closer to the fight it is a short camp of at least 3 weeks.'
	),
	constant(
		'muay_thai_sessions',
		'MUAY_THAI_SESSIONS',
		MUAY_THAI_SESSIONS,
		'Muay Thai rises from 3 to 5 sessions a week across the camp, never more than you have room for; a hard class counts as hard sparring.'
	),
	constant(
		'hard_sparring',
		'HARD_SPARRING',
		HARD_SPARRING,
		'Hard sparring rises from 1 to 2 sessions a week, never more than 2, with rounds rising from 4 to 8; someone who does not spar gets none.'
	),
	constant(
		'last_hard_sparring',
		'LAST_HARD_SPARRING',
		LAST_HARD_SPARRING,
		'The last hard sparring is at least 7 days before the fight.'
	),
	constant(
		'conditioning',
		'CONDITIONING',
		CONDITIONING,
		'Conditioning is 2 sessions a week of 3-minute rounds, rising from 6 to 10 rounds, in every week but the first and the fight week.'
	),
	constant(
		'strength',
		'STRENGTH',
		STRENGTH,
		'Strength is held at its maintenance dose in 2 sessions a week biased to power, with none in the last 4 days before the fight.'
	),
	constant(
		'fight_week',
		'FIGHT_WEEK',
		FIGHT_WEEK,
		'The fight week is technique and light pads only, with no hard sparring and no conditioning.'
	),
	constant(
		'weight_cut',
		'WEIGHT_CUT',
		WEIGHT_CUT,
		'Weight cutting is out of scope: the camp plans training and never plans, advises on or tracks making weight.'
	),
	{
		id: 'fight_camp.weeks',
		kind: 'behaviour',
		statement:
			'A fight camp is planned as weeks ending in the fight week: building camp weeks, then the sparring peak, then the technical fight week.',
		rationale:
			'Load builds while the fight is far off and stops in time, so fitness and sharpness peak together on the night.',
		source: 'src/lib/domain/programming/periodisation/fight-camp.ts#fightCampWeeks'
	}
];
