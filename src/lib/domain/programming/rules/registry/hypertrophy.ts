/**
 * The hypertrophy rules (m7/10 hypertrophy-blocks): where a block's weekly hard sets per major
 * group start, how they rise and where they stop, the deload, the rep ranges and the RPE ramp.
 */
import { HYPERTROPHY } from '../hypertrophy.ts';
import { HARD_SET_RANGES, MAJOR_GROUPS } from '../volume.ts';
import type { RuleDefinition } from './types.ts';

const FILE = 'src/lib/domain/programming/rules/hypertrophy.ts';
const VOLUME = 'src/lib/domain/programming/rules/volume.ts';

/**
 * Rule `key`: its values are HYPERTROPHY's entry or, for the band and the groups the block reads
 * from M3, the live constant at the given source.
 */
const rule = (
	key: keyof typeof HYPERTROPHY,
	statement: string,
	[source, values]: [string, unknown] = [`${FILE}#HYPERTROPHY.${key}`, HYPERTROPHY[key]]
): RuleDefinition => ({
	id: `hypertrophy.${key}`,
	kind: 'constant',
	statement,
	rationale: HYPERTROPHY[key].why,
	source,
	values
});
const BAND: [string, unknown] = [
	`${VOLUME}#HARD_SET_RANGES.hypertrophy`,
	HARD_SET_RANGES.hypertrophy
];

export const rules: readonly RuleDefinition[] = [
	rule(
		'start',
		'A hypertrophy block’s first week starts at the low end of the split’s hard-set band per major group (10 of 10–20; 8 on a cut).',
		BAND
	),
	rule(
		'step',
		'Each building week adds 1 set per group (2 for intermediate and advanced lifters, and on a bulk), never more than 20 % over the week before; each week’s range is 2 sets wide.'
	),
	rule(
		'ceiling',
		'No week goes above the top of the band (20 sets per group; 16 on a cut, 80 % of the top).',
		BAND
	),
	rule(
		'deload',
		'The block ends in a deload at 60 % of the first week’s sets, RPE 6 at most, loads 10 % lighter.'
	),
	rule(
		'reps',
		'Compounds are done for 6–10 reps, isolations for 10–15, and isolations for small muscles (arms, calves, core) for 12–20.'
	),
	rule(
		'rpe',
		'The top set rises from RPE 7 to 8, 8.5 and 9 over the building weeks, and an isolation’s last set goes half a point higher, to 9.5 in the last week.'
	),
	rule(
		'block',
		'A hypertrophy block is 4 to 6 building weeks (4 by default), then one deload week.'
	),
	rule(
		'groups',
		'The weekly set range applies to the major groups (chest, back, shoulders, quads, hamstrings, glutes and hips); arms and calves get their sets from the compounds and the accessories.',
		[`${VOLUME}#MAJOR_GROUPS`, MAJOR_GROUPS]
	),
	{
		id: 'hypertrophy.weeks',
		kind: 'behaviour',
		statement:
			'A hypertrophy block’s building weeks each carry their own hard-set range per major group, never lower than the week before, then a deload.',
		rationale:
			'Volume that rises a little each week inside the productive range is what drives growth, and storing each week’s range lets the review judge the week by it.',
		source: 'src/lib/domain/programming/periodisation/hypertrophy.ts#hypertrophyWeeks'
	}
];
