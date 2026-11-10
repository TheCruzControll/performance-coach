/**
 * The m6 area (m7/13): M6's results, review, next-week, directive and next-block rules are
 * registered with their live values, and every rule key M6 code cites resolves, statically and in
 * the decisions its next blocks write, so a key M6 adds or renames fails here, not in the rules
 * reference. registry.test.ts checks every entry's source, values and wording, this area's
 * included.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { citedRuleKeys, staticRuleKeys } from '../../../../../../scripts/rule-keys';
import type { Exposure } from '../../../analytics/prescribed';
import { CATALOGUE } from '../../../exercises/index';
import { generateProgram } from '../../generate';
import { buildProgrammingInput } from '../../input';
import { nextBlockDates } from '../../next-block/dates';
import { generateNextBlock, SIGNIFICANT } from '../../next-block/generate';
import { nextBlockInput } from '../../next-block/input';
import { DELOAD_AFTER_WEEKS } from '../../review/cycle';
import { DIRECTIVE_RULES } from '../../review/directives';
import type { CycleDirectives } from '../../review/directives';
import {
	DELOAD,
	LIGHT_WEEK_KINDS,
	MAX_NEXT_WEEK_OPS,
	MOVE_SEVERITY,
	SESSIONS_A_DAY
} from '../../review/next-week';
import { SCENARIO_START, SCENARIOS, scenarioDay } from '../../scenarios';
import type { ScenarioKey } from '../../scenarios';
import { DELOAD_REASON } from '../../stages/results';
import { FATIGUE_RULES, RESULT_RULES, RUN_RESULT_RULES } from '../results';
import { RULE_BY_ID } from './index';
import { rules } from './m6';

/** M6's code: results, the reviews, the next block and its stages, and the reviews service. */
const M6_SOURCES = [
	'src/lib/domain/programming/results.ts',
	'src/lib/domain/programming/rules/results.ts',
	'src/lib/domain/programming/review/**/*.ts',
	'src/lib/domain/programming/next-block/**/*.ts',
	'src/lib/domain/programming/stages/{carryover,next-shape,results}.ts',
	'src/lib/server/services/reviews/**/*.ts'
];

/** Three sessions a full RPE easier than prescribed: each lift goes up by its results. */
const EASY: Exposure[] = [3, 4, 5].map((week) => ({
	day: scenarioDay(week, 0),
	lineage: 'lineage',
	exerciseId: 'x',
	substituted: false,
	sets: { prescribed: 4, completed: 4, extra: 0 },
	missedReps: 0,
	rpeDeviations: [-1],
	rpeTargets: [8],
	meanRpeDeviation: -1,
	topSet: null,
	kg: 100,
	hit: true
}));

/** The decisions of the block after M3's first block for `key`, with the deload `deload`. */
function nextBlockDecisions(key: ScenarioKey, deload: CycleDirectives['deload']) {
	const profile = SCENARIOS[key]();
	const input = buildProgrammingInput(profile, { catalogue: CATALOGUE });
	const first = generateProgram(input, {
		startsOn: SCENARIO_START,
		firstPlannedDay: SCENARIO_START
	});
	const [previous, outline = null] = first.blocks;
	const directives: CycleDirectives = {
		fromBlockLineage: 'lineage',
		phase: outline?.phase ?? previous!.phase,
		weeks: 4,
		fromOutline: outline !== null,
		keep: [],
		rotate: [],
		volume: [],
		rpe: [7, 8.5],
		deload,
		running: null,
		avoidDays: [],
		progression: 'progress'
	};
	const dates = nextBlockDates({
		blocks: first.blocks,
		reviewedBlock: 0,
		today: scenarioDay(6, 0),
		start: 'this_week',
		events: profile.goals.flatMap((g) => (g.eventDate ? [g.eventDate] : [])),
		weeks: directives.weeks
	});
	const snapshot = { timeZone: 'UTC', e1rms: [], maxes: [], running: null };
	const results = ['back_squat', 'bench_press'].map((exercise) => ({
		exercise,
		exposures: EASY,
		trend: null
	}));
	return generateNextBlock(nextBlockInput(input, snapshot, directives), {
		dates,
		outline,
		previous: { block: previous!, results, unit: 'kg' },
		directives
	}).decisions;
}

let cited: Set<string>;
let own: Set<string>;
let decided: Set<string>;
// Scanning M6's sources builds a TypeScript program: seconds, not milliseconds.
beforeAll(() => {
	const decisions = (['beginner', 'hybrid'] as const).flatMap((key) =>
		(['first', 'last'] as const).flatMap((deload) => nextBlockDecisions(key, deload))
	);
	decided = new Set(decisions.flatMap((d) => (d.ruleKey ? [d.ruleKey] : [])));
	cited = citedRuleKeys(M6_SOURCES, decisions);
	own = staticRuleKeys(M6_SOURCES);
}, 120_000);
const live = (id: string) => {
	const rule = RULE_BY_ID.get(id);
	return rule?.kind === 'constant' ? rule.values : undefined;
};

describe('the m6 rules', () => {
	it('every rule key M6 code cites, and its next blocks decide, resolves to a registered rule', () => {
		expect(own.size).toBeGreaterThan(30);
		for (const key of ['next_block.planned', 'results.deload_first', 'results.deload_last'])
			expect(decided.has(key), key).toBe(true);
		expect([...decided].some((key) => key.startsWith('results.below'))).toBe(true);
		expect([...cited].filter((key) => !RULE_BY_ID.has(key))).toEqual([]);
	});

	it('registers each key M6 code cites in the m6 area, and a rule nothing cites only as a constant', () => {
		for (const key of own) expect(RULE_BY_ID.get(key)?.area, key).toBe('m6');
		const uncited = rules.filter((rule) => !own.has(rule.id));
		expect(uncited.filter((rule) => rule.kind === 'behaviour').map((rule) => rule.id)).toEqual([]);
	});

	it('reads the next-week adjustment rules live', () => {
		expect(live('next_week.deload')).toBe(DELOAD);
		expect(RULE_BY_ID.get('next_week.deload')?.statement).toContain(
			'40 % fewer sets and RPE at most 6'
		);
		expect(live('next_week.light_weeks')).toBe(LIGHT_WEEK_KINDS);
		expect(RULE_BY_ID.get('next_week.light_weeks')?.statement).toContain('only caps');
		expect(live('next_week.max_ops')).toBe(MAX_NEXT_WEEK_OPS);
		expect(MAX_NEXT_WEEK_OPS).toBe(12);
		expect(live('next_week.move_severity')).toBe(MOVE_SEVERITY);
		expect(live('next_week.sessions_a_day')).toBe(SESSIONS_A_DAY);
		expect(live('results.run.weekly_cap')).toBe(RUN_RESULT_RULES.maxWeeklyRise);
		expect(RULE_BY_ID.get('results.run.weekly_cap')?.statement).toContain('at most 10 %');
		expect(RULE_BY_ID.get('results.long_run.repeat')).toMatchObject({
			kind: 'behaviour',
			source: 'src/lib/domain/programming/results.ts#adaptRunning'
		});
	});

	it('reads the results, fatigue, directive and next-block constants live', () => {
		expect(live('results.rules')).toBe(RESULT_RULES);
		expect(live('results.below')).toBe(RESULT_RULES.below);
		expect(live('results.missed_repeat')).toBe(RESULT_RULES.missedRepeat);
		expect(live('results.fatigue_signals')).toBe(FATIGUE_RULES.signals);
		expect(live('results.fatigue_high')).toBe(FATIGUE_RULES.highSignals);
		expect(live('directives.rpe')).toBe(DIRECTIVE_RULES.rpe);
		expect(live('directives.volume_step')).toBe(DIRECTIVE_RULES.volumeStep);
		expect(live('review.deload_after_weeks')).toBe(DELOAD_AFTER_WEEKS);
		expect(live('next_block.hard_sets')).toBe(SIGNIFICANT.hardSets);
		expect(live('next_block.significant')).toBe(SIGNIFICANT);
	});

	it('names the function that applies each review and next-block rule with no constant', () => {
		const sourceOf = (id: string) => RULE_BY_ID.get(id)?.source;
		const AT = 'src/lib/domain/programming';
		expect(sourceOf('next_block.planned')).toBe(`${AT}/next-block/generate.ts#generateNextBlock`);
		expect(sourceOf('carryover.kept')).toBe(`${AT}/stages/carryover.ts#carryover`);
		expect(sourceOf('results.noisy')).toBe(`${AT}/results.ts#decideFromResults`);
		expect(sourceOf('results.below.at_limit')).toBe(`${AT}/results.ts#decideFromResults`);
		expect(RULE_BY_ID.get('results.deload_first')).toMatchObject({
			kind: 'behaviour',
			source: `${AT}/review/directives.ts#directivesFrom`,
			rationale: DELOAD_REASON.first
		});
	});
});
