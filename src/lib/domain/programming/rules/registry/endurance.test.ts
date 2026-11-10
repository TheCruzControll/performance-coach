/**
 * The endurance area (m7/18): its keys, each reading the live constant the block plans from.
 * registry.test.ts checks every entry's source, values and wording.
 */
import { describe, expect, it } from 'vitest';
import { ENDURANCE, HALF_HOOKS } from '../endurance';
import { RULE_BY_ID } from './index';
import { rules } from './endurance';

const live = (id: string) => {
	const rule = RULE_BY_ID.get(id);
	return rule?.kind === 'constant' ? rule.values : undefined;
};

describe('the endurance rules', () => {
	it('registers every rule in this area, reading the live constants with their why', () => {
		const keys = Object.keys(ENDURANCE) as (keyof typeof ENDURANCE)[];
		expect(rules.map((rule) => rule.id)).toEqual([
			...keys.map((key) => `endurance.${key}`),
			'endurance.half_hooks',
			'endurance.hooks',
			'endurance.weeks'
		]);
		for (const { id } of rules) expect(RULE_BY_ID.get(id)?.area, id).toBe('endurance');
		for (const key of keys) {
			expect(live(`endurance.${key}`), key).toBe(ENDURANCE[key]);
			expect(RULE_BY_ID.get(`endurance.${key}`)?.rationale, key).toBe(ENDURANCE[key].why);
		}
		expect(live('endurance.half_hooks')).toBe(HALF_HOOKS);
	});

	it('holds the plan’s defaults', () => {
		expect(ENDURANCE).toMatchObject({
			phases: { marathon: { base: [4, 6], build: [6, 8] }, half: { base: [3, 4], build: [4, 6] } },
			increase: { max: 0.1 },
			regain: { max: 0.2, withinWeeks: 8 },
			cutback: { every: 4, factor: 0.8 },
			long_run: {
				stepMetres: 1500,
				cap: { marathon: { metres: 32_000, minutes: 180 }, half: { metres: 22_000, minutes: 180 } }
			},
			marathon_pace: { segment: 'steady', label: 'at marathon pace', share: [0.2, 0.4] },
			strength: { maintenanceIn: ['peak', 'taper'], noHeavyLowerDays: 5 }
		});
	});
});
