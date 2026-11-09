/**
 * The strength-phases rules (m7/09 strength-phases): each phase's main-lift scheme, the meet
 * taper's openers, and the sequence of phases that peaks a lifter for a meet.
 */
import { MEET_SEQUENCE, OPENERS, PHASE_SCHEMES } from '../strength-phases.ts';
import type { RuleDefinition } from './types.ts';

const FILE = 'src/lib/domain/programming/rules/strength-phases.ts';

const scheme = (role: keyof typeof PHASE_SCHEMES, statement: string): RuleDefinition => ({
	id: `strength_phases.${role}`,
	kind: 'constant',
	statement,
	rationale: PHASE_SCHEMES[role].why,
	source: `${FILE}#PHASE_SCHEMES.${role}`,
	values: PHASE_SCHEMES[role]
});

export const rules: readonly RuleDefinition[] = [
	scheme(
		'accumulation',
		'Accumulation weeks are sets of 6–8 on the main lifts, sets rising from the base to 15 % above it and the top set from RPE 7 to 8, loads +2.5 % a week.'
	),
	scheme(
		'intensification',
		'Intensification weeks are sets of 3–5 at 85 % then 80 % of the base sets, the top set from RPE 8 to 9, loads +2.5 % a week.'
	),
	scheme(
		'realization',
		'Realization (peak) weeks are singles to triples at 60 % then 50 % of the base sets, the top set from RPE 8.5 to 9.5, loads +2.5 % a week.'
	),
	scheme(
		'meet_taper',
		'The meet taper is half the base sets, singles and doubles at RPE 8 at the same loads, and running eased to 60 %.'
	),
	scheme(
		'meet',
		'The meet’s own week is a few singles at RPE 7 and 40 % of the sets, with running at 40 %.'
	),
	{
		id: 'strength_phases.openers',
		kind: 'constant',
		statement:
			'In the meet taper, each lift’s opener is a single at about 90 % of its e1RM, 4–5 days out.',
		rationale:
			'The first attempt is rehearsed at a load that is sure to go, early enough that it costs nothing on the day.',
		source: `${FILE}#OPENERS`,
		values: OPENERS
	},
	{
		id: 'strength_phases.meet_sequence',
		kind: 'constant',
		statement:
			'A meet is peaked by 4 ± 1 accumulation weeks, 3 ± 1 intensification, 2 realization and a 1-week taper; a shorter run-up gives up accumulation and intensification weeks first, and every sequence ends in the taper.',
		rationale:
			'Volume first, then intensity, then near-maximal practice, so fitness built early is expressed on the day; a short run-up keeps the heavy end and the taper.',
		source: `${FILE}#MEET_SEQUENCE`,
		values: MEET_SEQUENCE
	},
	{
		id: 'strength_phases.beginners',
		kind: 'constant',
		statement:
			'New and novice lifters get no realization: those weeks are planned as intensification.',
		rationale:
			'A beginner still gains from every heavier week, and has no near-maximal skill yet for peak weeks to sharpen.',
		source: `${FILE}#MEET_SEQUENCE.noRealization`,
		values: MEET_SEQUENCE.noRealization
	},
	{
		id: 'strength_phases.sequence',
		kind: 'behaviour',
		statement:
			'A strength block’s weeks run from accumulation to the meet’s week, each week’s targets stepping evenly from its phase’s first week to its last.',
		rationale:
			'Even steps make each week a little harder than the one before, so no week is a jump the lifter is not ready for.',
		source: 'src/lib/domain/programming/periodisation/strength.ts#meetSequence'
	}
];
