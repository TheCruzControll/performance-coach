/**
 * The targets rules (m7r/06 periodised-targets): which hard-set range per major group the Strength
 * view, the weekly review and the cycle review judge a week by
 * (src/lib/domain/programming/planned-targets.ts). An M7 week is judged by the band the generator
 * balanced it to, through the generator's own functions, so the plan and its review cannot
 * disagree; an earlier block keeps M6's rule. Each entry names the function that gives the band.
 */
import { PRE_M7_GENERATORS } from '../../planned-targets.ts';
import type { RuleDefinition } from './types.ts';

const DOMAIN = 'src/lib/domain/programming';

export const rules: readonly RuleDefinition[] = [
	{
		id: 'targets.own_range',
		kind: 'behaviour',
		statement:
			'A full-volume week that stores its own hard-set range per major group (a hypertrophy week’s rising range, a dosed week’s band) is judged by that range as it stands, not scaled again by the week’s volume. A deload, taper or event week is judged by the block’s first range times its volume.',
		rationale:
			'The generator balanced the week to that range, so judging it by anything else would call a week below or above target when its planned sets were done.',
		source: `${DOMAIN}/planned-targets.ts#weekBand`
	},
	{
		id: 'targets.generator_band',
		kind: 'behaviour',
		statement:
			'Any other week of a block planned by goal priority is judged by the generator’s band for the strength goal’s mode: its usual band when it leads, the lower half when it is secondary, the maintenance dose when it is held.',
		rationale:
			'The review should hold a week to what the plan asked of it: a goal held at its dose is not behind for doing its dose.',
		source: `${DOMAIN}/stages/volume.ts#heldBand`
	},
	{
		id: 'targets.prepared_split',
		kind: 'behaviour',
		statement:
			'That band is worked out from the goals as the generator ranked them at the block’s start, with each goal’s mode, not from the profile’s order alone.',
		rationale:
			'When an event moves a goal up, the generator chooses the split for the goal that leads, so the review has to read the same split.',
		source: `${DOMAIN}/planned-targets.ts#blockBands`
	},
	{
		id: 'targets.pre_m7',
		kind: 'constant',
		statement:
			'A block planned before goals were ranked by priority, or with no season, keeps the range it was always judged by: the band its stored input’s split gives, scaled by the week’s volume.',
		rationale:
			'Those blocks were balanced to that band, so their past weeks read exactly as they did before.',
		source: `${DOMAIN}/planned-targets.ts#PRE_M7_GENERATORS`,
		values: PRE_M7_GENERATORS
	}
];
