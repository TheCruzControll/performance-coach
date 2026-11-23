/**
 * The targets area (m7r/06): the rules the muscle-group targets judge a week by are registered,
 * each naming the function or constant that gives its band. registry.test.ts checks every entry's
 * source and wording.
 */
import { describe, expect, it } from 'vitest';
import { PRE_M7_GENERATORS } from '../../planned-targets';
import { RULE_BY_ID } from './index';
import { rules } from './targets';

describe('the targets rules', () => {
	it('registers the own range, the generator band, the prepared split and the pre-M7 rule', () => {
		expect(rules.map((rule) => rule.id)).toEqual([
			'targets.own_range',
			'targets.generator_band',
			'targets.prepared_split',
			'targets.pre_m7'
		]);
		for (const rule of rules) {
			expect(RULE_BY_ID.get(rule.id)).toMatchObject({ area: 'targets', status: 'active' });
		}
	});

	it('reads its bands from the functions the targets service calls', () => {
		const source = (id: string) => RULE_BY_ID.get(id)?.source;
		const domain = 'src/lib/domain/programming';
		expect(source('targets.own_range')).toBe(`${domain}/planned-targets.ts#weekBand`);
		expect(source('targets.generator_band')).toBe(`${domain}/stages/volume.ts#heldBand`);
		expect(source('targets.prepared_split')).toBe(`${domain}/planned-targets.ts#blockBands`);
		expect(RULE_BY_ID.get('targets.pre_m7')).toMatchObject({ values: PRE_M7_GENERATORS });
	});
});
