/**
 * The hypertrophy area (m7/10): its keys, each reading the live constant the block plans from.
 * registry.test.ts checks every entry's source, values and wording.
 */
import { describe, expect, it } from 'vitest';
import { HYPERTROPHY } from '../hypertrophy';
import { HARD_SET_RANGES, MAJOR_GROUPS } from '../volume';
import { RULE_BY_ID } from './index';
import { rules } from './hypertrophy';

const live = (id: string) => {
	const rule = RULE_BY_ID.get(id);
	return rule?.kind === 'constant' ? rule.values : undefined;
};

describe('the hypertrophy rules', () => {
	it('registers every rule in this area, reading the live constants', () => {
		expect(rules.map((rule) => rule.id)).toEqual([
			'hypertrophy.start',
			'hypertrophy.step',
			'hypertrophy.ceiling',
			'hypertrophy.deload',
			'hypertrophy.reps',
			'hypertrophy.rpe',
			'hypertrophy.block',
			'hypertrophy.groups',
			'hypertrophy.weeks'
		]);
		for (const { id } of rules) expect(RULE_BY_ID.get(id)?.area, id).toBe('hypertrophy');
		expect(live('hypertrophy.start')).toBe(HARD_SET_RANGES.hypertrophy);
		expect(live('hypertrophy.ceiling')).toBe(HARD_SET_RANGES.hypertrophy);
		expect(live('hypertrophy.groups')).toBe(MAJOR_GROUPS);
		for (const key of ['step', 'deload', 'reps', 'rpe', 'block'] as const) {
			expect(live(`hypertrophy.${key}`), key).toBe(HYPERTROPHY[key]);
		}
		for (const key of Object.keys(HYPERTROPHY) as (keyof typeof HYPERTROPHY)[]) {
			expect(RULE_BY_ID.get(`hypertrophy.${key}`)?.rationale, key).toBe(HYPERTROPHY[key].why);
		}
	});
});
