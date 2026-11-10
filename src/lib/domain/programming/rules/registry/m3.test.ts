/**
 * The m3 area (m7/12): M3's rules are registered with their live values, and every rule key M3
 * code cites resolves, so a key M3 adds or renames fails here, not in the rules reference.
 * registry.test.ts checks every entry's source, values and wording, this area's included.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { citedRuleKeys } from '../../../../../../scripts/rule-keys';
import { RELATED_PATTERNS } from '../../alternatives';
import { AVOID_PHRASES, INJURY_EXCLUSIONS } from '../../avoidance';
import { EQUIPMENT_NEEDED } from '../../eligibility';
import { FIRST_BLOCK, OUTLINES } from '../blocks';
import { SESSIONS_WANTED } from '../days';
import { DEFAULTS } from '../defaults';
import { LOAD_RULES } from '../loads';
import { MARATHON_HOOKS, RUN_WEEKLY_INCREASE_MAX } from '../running';
import { LAYOUTS, STYLES } from '../strength';
import { HARD_SET_RANGES } from '../volume';
import { RULE_BY_ID } from './index';
import { rules } from './m3';

/**
 * M3's code: the programming domain but M6's review, next block, results and next-block stages,
 * and the edits.
 */
const M3_SOURCES = [
	'src/lib/domain/programming/**/*.ts',
	'!src/lib/domain/programming/review/**',
	'!src/lib/domain/programming/next-block/**',
	'!src/lib/domain/programming/results.ts',
	'!src/lib/domain/programming/stages/{carryover,next-shape,results}.ts',
	'src/lib/server/services/programs/**/*.ts'
];

let cited: Set<string>;
// Scanning M3's sources builds a TypeScript program: seconds, not milliseconds.
beforeAll(() => void (cited = citedRuleKeys(M3_SOURCES)), 120_000);
const live = (id: string) => {
	const rule = RULE_BY_ID.get(id);
	return rule?.kind === 'constant' ? rule.values : undefined;
};

describe('the m3 rules', () => {
	it('every rule key M3 code and its scenario plans cite resolves to a registered rule', () => {
		expect(cited.size).toBeGreaterThan(80);
		expect([...cited].filter((key) => !RULE_BY_ID.has(key))).toEqual([]);
	});

	it('registers a rule nothing cites only as a constant, never as a behaviour', () => {
		const uncited = rules.filter((rule) => !cited.has(rule.id));
		expect(uncited.filter((rule) => rule.kind === 'behaviour').map((rule) => rule.id)).toEqual([]);
		expect(uncited.length).toBeGreaterThan(0);
	});

	it('reads the live constants, outside rules/ too', () => {
		expect(live('days.sessions_wanted')).toBe(SESSIONS_WANTED);
		expect(live('blocks.first_block')).toBe(FIRST_BLOCK);
		expect(live('blocks.outlines')).toBe(OUTLINES);
		expect(live('strength.maintenance')).toBe(LAYOUTS.maintenance);
		expect(live('strength.styles')).toBe(STYLES);
		expect(live('volume.maintenance')).toBe(HARD_SET_RANGES.maintenance);
		expect(live('loads.rules')).toBe(LOAD_RULES);
		expect(live('running.weekly_increase_max')).toBe(RUN_WEEKLY_INCREASE_MAX);
		expect(live('running.marathon_hooks')).toBe(MARATHON_HOOKS);
		expect(live('exercises.injury_exclusions')).toBe(INJURY_EXCLUSIONS);
		expect(live('exercises.avoid_phrases')).toBe(AVOID_PHRASES);
		expect(live('exercises.equipment_needed')).toBe(EQUIPMENT_NEEDED);
		expect(live('exercises.related_patterns')).toBe(RELATED_PATTERNS);
		for (const [key, rule] of Object.entries(DEFAULTS)) {
			expect(RULE_BY_ID.get(`defaults.${key}`), key).toMatchObject({
				area: 'm3',
				rationale: rule.rationale
			});
			expect(live(`defaults.${key}`), key).toBe(rule);
		}
	});

	it('names the function that applies each rule with no constant behind it', () => {
		const sourceOf = (id: string) => RULE_BY_ID.get(id)?.source;
		expect(RULE_BY_ID.get('goals.paused')).toMatchObject({ kind: 'behaviour', area: 'm3' });
		expect(sourceOf('goals.paused')).toBe('src/lib/domain/programming/blocks.ts#planFirstBlock');
		expect(sourceOf('days.free_days')).toBe('src/lib/domain/programming/demand.ts#allocateWeek');
		expect(sourceOf('placement.no_room')).toBe(
			'src/lib/domain/programming/placement.ts#placeSessions'
		);
		expect(sourceOf('program.baseline_week')).toBe(
			'src/lib/domain/programming/generate.ts#generateProgram'
		);
	});

	it('states each week kind’s progression from its live targets', () => {
		expect(RULE_BY_ID.get('progression.deload')?.statement).toBe(
			'Deload weeks: strength to RPE 6, 60 % of the sets, loads −10 % and running at 70 % of week 1.'
		);
		expect(RULE_BY_ID.get('progression.accumulation')?.statement).toContain(
			'in its first step, each later step a little more.'
		);
		expect(RULE_BY_ID.get('progression.cutback')?.statement).toBe(
			'Cutback weeks progress by the targets of the block that plans them; M3 plans none.'
		);
	});
});
