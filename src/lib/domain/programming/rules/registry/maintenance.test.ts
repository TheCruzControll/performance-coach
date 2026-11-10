/**
 * The maintenance area (m7/16): each dose, the secondary band and the maintenance block are
 * registered with their live constants. registry.test.ts checks every entry's source and wording.
 */
import { describe, expect, it } from 'vitest';
import { DOSES, MAINTENANCE_BLOCK, SECONDARY } from '../maintenance';
import { RULE_BY_ID } from './index';
import { rules } from './maintenance';

const live = (id: string) => {
	const rule = RULE_BY_ID.get(id);
	return rule?.kind === 'constant' ? rule.values : undefined;
};

describe('the maintenance rules', () => {
	it('registers every stream’s dose, the secondary band and the block, each live', () => {
		for (const stream of Object.keys(DOSES) as (keyof typeof DOSES)[]) {
			expect(live(`maintenance.${stream}`)).toBe(DOSES[stream]);
		}
		expect(live('maintenance.secondary')).toBe(SECONDARY);
		expect(live('maintenance.block')).toBe(MAINTENANCE_BLOCK);
		expect(rules).toHaveLength(Object.keys(DOSES).length + 2);
		expect(rules.every((rule) => RULE_BY_ID.get(rule.id)?.area === 'maintenance')).toBe(true);
	});

	it("builds on M3's maintenance split rather than a band of its own", () => {
		expect(DOSES.strength).toMatchObject({ hardSets: [4, 10], setsPerSlot: 2, topSetRpeCap: 8 });
		expect(SECONDARY.bands).toEqual({ strength: [8, 11], hypertrophy: [10, 15] });
		expect(MAINTENANCE_BLOCK).toMatchObject({ weeks: { min: 4, max: 8 }, deload: false });
	});
});
