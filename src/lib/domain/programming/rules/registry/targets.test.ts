/**
 * The targets area (m7/31): the rules M6's muscle-group targets judge a week by are registered,
 * each naming the generator function that gives its band. registry.test.ts checks every entry's
 * source and wording.
 */
import { describe, expect, it } from 'vitest';
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

	it('reads its bands from the generator’s own functions', () => {
		const source = (id: string) => RULE_BY_ID.get(id)?.source;
		expect(source('targets.own_range')).toBe(
			'src/lib/domain/programming/stages/volume.ts#balancePhased'
		);
		expect(source('targets.generator_band')).toBe(
			'src/lib/domain/programming/stages/volume.ts#heldBand'
		);
		expect(source('targets.prepared_split')).toBe(
			'src/lib/domain/programming/stages/prepare.ts#prepare'
		);
	});
});
