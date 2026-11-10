/**
 * The m4 area (m7/13): M4's pain and quick-action rules are registered with their live values and
 * rationales, and every rule key M4 code cites resolves. registry.test.ts checks every entry's
 * source, values and wording, this area's included.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { citedRuleKeys, staticRuleKeys } from '../../../../../../scripts/rule-keys';
import { QUICK_ACTIONS } from '../../../workout/substitution';
import { GENTLER_WORDS, PAIN_RULES } from '../pain';
import { RULE_BY_ID } from './index';
import { rules } from './m4';

/** M4's code: the workout domain, and 'This hurts' with its rules. */
const M4_SOURCES = [
	'src/lib/domain/workout/**/*.ts',
	'src/lib/domain/programming/pain.ts',
	'src/lib/domain/programming/rules/pain.ts'
];

let cited: Set<string>;
let own: Set<string>;
// Scanning builds a TypeScript program: seconds, not milliseconds.
beforeAll(() => {
	cited = citedRuleKeys(M4_SOURCES);
	own = staticRuleKeys(M4_SOURCES);
}, 120_000);
const live = (id: string) => {
	const rule = RULE_BY_ID.get(id);
	return rule?.kind === 'constant' ? rule.values : undefined;
};

describe('the m4 rules', () => {
	it('every rule key M4 code cites resolves to a registered rule', () => {
		expect([...cited].filter((key) => !RULE_BY_ID.has(key))).toEqual([]);
	});

	it('cites no rule key of its own, so every m4 entry is a constant', () => {
		expect([...own]).toEqual([]);
		expect(rules.filter((rule) => rule.kind !== 'constant').map((rule) => rule.id)).toEqual([]);
		for (const rule of rules) expect(RULE_BY_ID.get(rule.id)?.area, rule.id).toBe('m4');
	});

	it('reads each pain rule live, with the rationale beside its value', () => {
		const ids = {
			severity: 'pain.severity',
			noHarder: 'pain.no_harder',
			loadTags: 'pain.load_tags',
			supportedEquipment: 'pain.supported_equipment',
			limit: 'pain.limit'
		} as const;
		expect(Object.keys(ids).sort()).toEqual(Object.keys(PAIN_RULES).sort());
		for (const [key, id] of Object.entries(ids) as [keyof typeof ids, string][]) {
			expect(live(id), id).toBe(PAIN_RULES[key]);
			expect(RULE_BY_ID.get(id)?.rationale, id).toBe(PAIN_RULES[key].rationale);
		}
		expect(live('pain.gentler_words')).toBe(GENTLER_WORDS);
		expect(RULE_BY_ID.get('pain.limit')?.statement).toContain(`At most ${PAIN_RULES.limit.value}`);
	});

	it('reads every quick action live', () => {
		for (const [action, rule] of Object.entries(QUICK_ACTIONS)) {
			expect(live(`substitution.${action}`), action).toBe(rule);
		}
	});
});
