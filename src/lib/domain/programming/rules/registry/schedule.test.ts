/**
 * The schedule area (m7/21): every rule key the scheduler cites resolves to a registered rule, and
 * its own keys are this area's. registry.test.ts checks every entry's source, values and wording.
 */
import { describe, expect, it } from 'vitest';
import { staticRuleKeys } from '../../../../../../scripts/rule-keys';
import { ACTIONS, BOUNDS, EASE, OBJECTIVE } from '../schedule';
import { RULE_BY_ID } from './index';
import { rules } from './schedule';

const live = (id: string) => {
	const rule = RULE_BY_ID.get(id);
	return rule?.kind === 'constant' ? rule.values : undefined;
};

describe('the schedule rules', () => {
	it(
		'every rule key the scheduler cites resolves, its own keys in this area',
		{ timeout: 60_000 },
		() => {
			const cited = [...staticRuleKeys(['src/lib/domain/programming/schedule/**/*.ts'])].sort();
			expect(cited).toEqual(['schedule.drop', 'schedule.priority_kept']);
			for (const key of cited) expect(RULE_BY_ID.get(key)?.area).toBe('schedule');
		}
	);

	it('reads the live constants', () => {
		expect(live('schedule.actions')).toBe(ACTIONS);
		expect(live('schedule.objective')).toBe(OBJECTIVE);
		expect(live('schedule.bounds')).toBe(BOUNDS);
		expect(live('schedule.ease')).toBe(EASE);
		expect(rules.every((rule) => rule.id.startsWith('schedule.'))).toBe(true);
	});
});
