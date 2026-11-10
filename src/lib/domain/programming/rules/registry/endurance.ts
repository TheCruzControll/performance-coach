/**
 * The endurance rules (m7/18 endurance-blocks): a marathon's and a half's phases, the weekly
 * growth and its one exception, cutbacks, the long run, the race-specific work and strength in
 * the last weeks, each reading the live constant the block plans from.
 */
import { ENDURANCE, HALF_HOOKS } from '../endurance.ts';
import type { RuleDefinition } from './types.ts';

const FILE = 'src/lib/domain/programming/rules/endurance.ts';

/** Rule `key`: its values are ENDURANCE's entry, its rationale the entry's why. */
const rule = (key: keyof typeof ENDURANCE, statement: string): RuleDefinition => ({
	id: `endurance.${key}`,
	kind: 'constant',
	statement,
	rationale: ENDURANCE[key].why,
	source: `${FILE}#ENDURANCE.${key}`,
	values: ENDURANCE[key]
});

export const rules: readonly RuleDefinition[] = [
	rule(
		'phases',
		'A marathon block has 4–6 base and 6–8 build weeks, then 3 peak and 3 taper weeks; a half 3–4 base, 4–6 build, 2 peak and 2 taper. A short runway shortens the base first and keeps the taper.'
	),
	rule(
		'increase',
		'Each week’s running grows at most 10 % over the biggest week before it (peak weeks hold it).'
	),
	rule(
		'regain',
		'The one exception to 10 %: a weekly mileage held in the last 8 weeks may be regained at up to 20 % a week, never above it, and the week says so.'
	),
	rule(
		'cutback',
		'Every 4th week of base and build is a cutback at 80 % of the biggest week so far.'
	),
	rule(
		'long_run',
		'The long run grows at most 1.5 km a week, to 30 % of the week (35 % in a marathon peak), capped at 32 km or 3 hours (22 km for a half).'
	),
	rule('ceiling', 'No week asks for more than double the running of the block’s first week.'),
	rule(
		'race_work',
		'Marathon build and peak weeks hold marathon-pace work and a threshold run; a half’s hold a threshold run and 10K-pace intervals; each taper keeps one.'
	),
	rule(
		'marathon_pace',
		'Marathon-pace work is a steady segment at marathon pace, labelled ‘at marathon pace’, for 20 % of the long run rising to 40 % over the build, and 40 % in peak.'
	),
	rule(
		'quality',
		'Threshold runs are tempo segments at threshold pace; 10K-pace intervals run between threshold’s fast end and VO2max’s slow end.'
	),
	rule(
		'strength',
		'In peak and taper weeks strength is at its maintenance dose, top sets at RPE 8 at most, with no heavy lower-body work in the 5 days before the race.'
	),
	{
		id: 'endurance.half_hooks',
		kind: 'constant',
		statement:
			'A half’s phases have their own hooks: growth 10 % in base and build and held in peak, 1 quality session in base and taper and 2 in build and peak, the long run at most 30 % of the week.',
		rationale:
			'A half is raced faster than a marathon, so its build carries two quality sessions while its long run stays shorter.',
		source: `${FILE}#HALF_HOOKS`,
		values: HALF_HOOKS
	},
	{
		id: 'endurance.hooks',
		kind: 'behaviour',
		statement:
			'A marathon phase reads M3’s marathon hooks and a half phase the half’s hooks, for its growth, quality sessions and long-run share.',
		rationale:
			'One lookup keeps the generator and the block reading the same numbers, so a half never trains on marathon hooks.',
		source: `${FILE}#hooksFor`
	},
	{
		id: 'endurance.weeks',
		kind: 'behaviour',
		statement:
			'A marathon or half block is planned back from race day as base, build, peak, taper and race weeks, each with its mileage, long run and race-specific work.',
		rationale:
			'Counting back from the race keeps the taper and the race-specific weeks whatever the runway, and each week records why its mileage moved.',
		source: 'src/lib/domain/programming/periodisation/endurance.ts#enduranceWeeks'
	}
];
