/**
 * The fight-camp area (m7/19): each camp rule is registered with its live constant, weight
 * cutting is registered as out of scope, and the planner is registered as the camp's behaviour.
 * registry.test.ts checks every entry's source and wording.
 */
import { describe, expect, it } from 'vitest';
import * as camp from '../fight-camp';
import { RULE_BY_ID } from './index';
import { rules } from './fight-camp';

const live = (id: string) => {
	const rule = RULE_BY_ID.get(id);
	return rule?.kind === 'constant' ? rule.values : undefined;
};

describe('the fight-camp rules', () => {
	it('registers every camp constant live, and the planner as a behaviour', () => {
		expect(live('fight_camp.camp_weeks')).toBe(camp.CAMP_WEEKS);
		expect(live('fight_camp.muay_thai_sessions')).toBe(camp.MUAY_THAI_SESSIONS);
		expect(live('fight_camp.hard_sparring')).toBe(camp.HARD_SPARRING);
		expect(live('fight_camp.last_hard_sparring')).toBe(camp.LAST_HARD_SPARRING);
		expect(live('fight_camp.conditioning')).toBe(camp.CONDITIONING);
		expect(live('fight_camp.strength')).toBe(camp.STRENGTH);
		expect(live('fight_camp.fight_week')).toBe(camp.FIGHT_WEEK);
		expect(RULE_BY_ID.get('fight_camp.weeks')).toMatchObject({
			kind: 'behaviour',
			source: 'src/lib/domain/programming/periodisation/fight-camp.ts#fightCampWeeks'
		});
		expect(rules).toHaveLength(9);
		expect(rules.every((rule) => RULE_BY_ID.get(rule.id)?.area === 'fight-camp')).toBe(true);
	});

	it('says weight cutting is out of scope', () => {
		expect(live('fight_camp.weight_cut')).toBe(camp.WEIGHT_CUT);
		expect(camp.WEIGHT_CUT.inScope).toBe(false);
		expect(RULE_BY_ID.get('fight_camp.weight_cut')?.statement).toMatch(/out of scope/);
	});

	it('shares the concurrent rules’ sparring cap and fight lead rather than its own', () => {
		expect(camp.HARD_SPARRING.max).toBe(2);
		expect(camp.LAST_HARD_SPARRING.daysOut).toBe(7);
		expect(camp.STRENGTH.dose).toMatchObject({ hardSets: [4, 10], topSetRpeCap: 8 });
	});
});
