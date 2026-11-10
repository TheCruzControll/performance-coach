import { describe, expect, it } from 'vitest';
import { staticRuleKeys } from '../../../../../scripts/rule-keys';
import { addDays, daysBetween } from '../../calendar';
import type { IsoDate } from '../../calendar';
import { CATALOGUE } from '../../exercises/index';
import type { TrainingProfile } from '../../profile/types';
import { periodisedWeekTargetsSchema, programPlanSchema } from '../../training/schemas';
import type { ProgramPlan } from '../../training/types';
import { validate } from '../../validation';
import { planFirstBlock } from '../blocks';
import { DecisionLog } from '../decisions';
import { buildProgrammingInput } from '../input';
import { weekTargets } from '../rules/blocks';
import { CADENCE, TARGETS } from '../rules/deload';
import { RULE_BY_ID } from '../rules/registry/index';
import { PLAN_BUDGET, TAPER_GUARD } from '../rules/road';
import { SCENARIOS, SCENARIO_START } from '../scenarios';
import type { ScenarioKey } from '../scenarios';
import { deloadWeek } from './deload';
import { M7_SCENARIOS, m7Day } from './scenarios';
import { planSeason, toBlockPlans } from './season';
import type { BlockSkeleton, SeasonOptions, SeasonPlan } from './season';

const START = SCENARIO_START;
const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });

function plan(profile: TrainingProfile, options?: SeasonOptions): SeasonPlan {
	const result = planSeason(inputOf(profile), START, options);
	if ('refusal' in result) throw new Error(result.why);
	return result;
}

const weeksOf = (b: Pick<BlockSkeleton, 'startsOn' | 'endsOn'>) =>
	(daysBetween(b.startsOn, b.endsOn) + 1) / 7;
/** Each block as [phase, weeks, outline]. */
const road = (blocks: readonly BlockSkeleton[]) =>
	blocks.map((b) => [b.phase, weeksOf(b), b.outline]);
const kinds = (b: BlockSkeleton) => b.weeks.map((w) => w.kind);
const sunday = (date: IsoDate) => addDays(date, 6 - ((new Date(date).getUTCDay() + 6) % 7));

/** `profile` with its Muay Thai experience at `level`. */
const muayThaiAt = (profile: TrainingProfile, level: 'advanced'): TrainingProfile => ({
	...profile,
	experience: profile.experience.map((e) => (e.discipline === 'muay_thai' ? { ...e, level } : e))
});

describe('planSeason', () => {
	it('plans PRD §2 end to end: a fight camp with its deload, the marathon road, ending in recovery and the block after', () => {
		const { blocks, dosesByWeek, decisions } = plan(M7_SCENARIOS.multiGoal());
		const fight = m7Day(10, 5);
		const marathon = m7Day(24, 6);
		expect(road(blocks)).toEqual([
			['fight_camp', 10, false],
			['recovery', 1, true],
			['marathon_base', 1, true],
			['marathon_build', 6, true],
			['marathon_peak', 3, true],
			['marathon_taper', 3, true],
			['recovery', 2, true],
			['hypertrophy', 4, true]
		]);
		const [camp] = blocks as [BlockSkeleton];
		expect(camp).toMatchObject({ type: 'fight_camp', startsOn: START, endsOn: sunday(fight) });
		expect(blocks[5]).toMatchObject({ endsOn: marathon, event: 'Marathon' });
		expect(camp.event).toBe('Muay Thai fight');
		// The baseline, then a deload after 4 loading weeks (intermediate), the peak and the fight week.
		expect(kinds(camp)).toEqual([
			'baseline',
			'build',
			'build',
			'build',
			'deload',
			'build',
			'build',
			'build',
			'peak',
			'event'
		]);
		expect(CADENCE.weeks.intermediate).toBe(4);
		expect(camp.weeks[0]!.targets.rpeCap).toBeLessThanOrEqual(7);
		expect(camp.weeks[4]!.targets.combat).toMatchObject({ hardSparring: 0, sparringRounds: 0 });
		expect(Math.max(...camp.weeks.map((w) => w.targets.combat!.hardSparring))).toBe(2);
		camp.weeks.forEach((w, i) => expect(w.startsOn).toBe(addDays(START, 7 * i)));

		// Build muscle and keep strength are held at their doses all camp; the marathon from its overlap.
		const held = (i: number) => dosesByWeek[i]!.doses.map((d) => `${d.goal.title}:${d.stream}`);
		expect(dosesByWeek.map((w) => w.startsOn)).toEqual(camp.weeks.map((w) => w.startsOn));
		expect(held(0)).toEqual(['Build muscle:hypertrophy', 'Keep strength:strength']);
		expect(held(9)).toEqual(expect.arrayContaining(['Build muscle:hypertrophy', 'Marathon:runs']));

		const tapers = decisions.filter((d) => d.kind === 'taper_planned');
		expect(tapers.map((d) => [d.ruleKey, d.evidence.event, d.refs])).toEqual([
			['taper.fight', 'Muay Thai fight', ['blocks.0']],
			['taper.marathon', 'Marathon', ['blocks.5']]
		]);
		expect(tapers[1]!.evidence).toMatchObject({
			length: '3 weeks',
			steps: '80, 60, 40 % of the volume'
		});
		expect(decisions.find((d) => d.kind === 'sparring_load')?.evidence).toMatchObject({
			count: 2,
			last: addDays(fight, -7),
			ramp: '1, 1, 1, 1, 0, 1, 2, 2, 2, 0'
		});
		expect(decisions.filter((d) => d.kind === 'maintenance_dose')).toHaveLength(2);
	});

	it('plans the hybrid marathon as M3 did: base, then build, peak 3 and taper 3 to race day', () => {
		const { blocks } = plan(SCENARIOS.hybrid());
		expect(road(blocks).slice(0, 4)).toEqual([
			['marathon_base', 5, false],
			['marathon_build', 9, true],
			['marathon_peak', 3, true],
			['marathon_taper', 3, true]
		]);
		expect(blocks[3]).toMatchObject({ endsOn: m7Day(20, 6), event: 'Marathon' });
		expect(road(blocks)[4]).toEqual(['recovery', 2, true]);
		expect(blocks[5]).toMatchObject({ startsOn: m7Day(23, 0), outline: true });
	});

	it('peaks the powerlifter: accumulation, intensification, realization, then the taper on meet week', () => {
		const { blocks } = plan(SCENARIOS.powerlifter());
		expect(blocks.map((b) => b.phase)).toEqual([
			'accumulation',
			'intensification',
			'realization',
			'taper',
			'maintenance'
		]);
		expect(blocks[3]).toMatchObject({ endsOn: m7Day(16, 6), event: 'Meet' });
	});

	it('builds a hypertrophy block with its deload at the cadence and the sets ramp in one decision', () => {
		const { blocks, decisions } = plan(M7_SCENARIOS.hypertrophyBlock());
		const [block] = blocks as [BlockSkeleton];
		expect(road(blocks)).toEqual([
			['hypertrophy', 5, false],
			['hypertrophy', 7, true]
		]);
		expect(kinds(block)).toEqual([
			'baseline',
			'accumulation',
			'accumulation',
			'accumulation',
			'deload'
		]);
		expect(kinds(block).indexOf('deload')).toBe(CADENCE.weeks.intermediate);
		const mins = block.weeks.slice(0, 4).map((w) => w.targets.setsPerGroup!.min);
		expect(mins).toEqual([10, 12, 14, 16]);
		const volume = decisions.filter((d) => d.kind === 'volume_progressed');
		expect(volume).toHaveLength(1);
		expect(volume[0]).toMatchObject({
			ruleKey: 'hypertrophy.step',
			refs: ['blocks.0'],
			evidence: { from: 10, to: 16, ramp: '10, 12, 14, 16', step: 'up to 2 sets' }
		});
	});

	it('plans an off-season as one maintenance block, then a maintenance outline', () => {
		const { blocks } = plan(M7_SCENARIOS.offSeason());
		expect(road(blocks)).toEqual([
			['maintenance', 5, false],
			['maintenance', 7, true]
		]);
		expect(new Set(kinds(blocks[0]!))).toEqual(new Set(['maintenance']));
		expect(blocks[0]!.weeks[0]!.targets.maintenance).toEqual(['strength', 'runs']);
	});

	it('keeps M3’s all-goals-paused block: its phase, goal refs and length', () => {
		const input = inputOf(M7_SCENARIOS.allPaused());
		const result = planSeason(input, START);
		if ('refusal' in result) throw new Error(result.why);
		const [m3] = planFirstBlock(input, START, new DecisionLog());
		const [block] = result.blocks as [BlockSkeleton];
		expect([block.phase, block.goalRefs, block.endsOn]).toEqual([
			m3!.phase,
			m3!.goalRefs,
			m3!.endsOn
		]);
		expect(block.goalRefs).toEqual(input.refs.paused);
	});

	it.each([
		'beginner',
		'powerlifter',
		'hybrid',
		'injuredShoulder',
		'dumbbellsOnly',
		'minimal'
	] as const)('keeps M3’s first block for %s', (key: ScenarioKey) => {
		const input = inputOf(SCENARIOS[key]());
		const result = planSeason(input, START);
		if ('refusal' in result) throw new Error(result.why);
		const [m3] = planFirstBlock(input, START, new DecisionLog());
		expect(toBlockPlans(result.blocks)[0]).toEqual(m3);
	});

	it('turns the journey’s fight in week 5 into a short fight camp ending on fight week', () => {
		const { blocks } = plan(SCENARIOS.journey());
		const [camp] = blocks as [BlockSkeleton];
		expect(camp).toMatchObject({ type: 'fight_camp', phase: 'fight_camp', endsOn: m7Day(5, 6) });
		expect(kinds(camp)).toEqual(['baseline', 'build', 'build', 'peak', 'event']);
	});

	it('holds a scheduled deload back within 3 weeks of the fight week', () => {
		// Advanced deloads after 3 loading weeks: weeks 4 and 8, but week 8 is 2 weeks from the fight.
		const { blocks } = plan(muayThaiAt(M7_SCENARIOS.multiGoal(), 'advanced'));
		const deloads = kinds(blocks[0]!).flatMap((k, i) => (k === 'deload' ? [i] : []));
		expect(deloads).toEqual([3]);
		expect(TAPER_GUARD.weeksBefore).toBe(3);
	});

	it('carries a phase on with no baseline week, and can start on a deload', () => {
		const fresh = plan(M7_SCENARIOS.hypertrophyBlock()).blocks[0]!;
		const carried = plan(M7_SCENARIOS.hypertrophyBlock(), {
			continuity: { phase: 'hypertrophy', weeksDone: 2 }
		}).blocks[0]!;
		expect(kinds(carried)).toEqual(['accumulation', 'accumulation', 'deload']);
		expect(carried.weeks[0]!.targets).toEqual(fresh.weeks[2]!.targets);

		const deloaded = plan(M7_SCENARIOS.offSeason(), { deloadFirst: true }).blocks[0]!;
		expect(kinds(deloaded)[0]).toBe('deload');
		const maintenance = plan(M7_SCENARIOS.offSeason()).blocks[0]!.weeks[0]!;
		expect(deloaded.weeks[0]!.targets).toEqual(
			deloadWeek(maintenance.targets, TARGETS, 'maintenance')
		);
	});

	it('carries the phase M3’s first block started on to the event, folding the gap before it', () => {
		const lifter = plan(SCENARIOS.powerlifter(), {
			continuity: { phase: 'accumulation', weeksDone: 2 }
		});
		expect(road(lifter.blocks).slice(0, 4)).toEqual([
			['accumulation', 7, false],
			['intensification', 5, true],
			['realization', 2, true],
			['taper', 2, true]
		]);
		const chosen = lifter.decisions.find(
			(d) => d.kind === 'block_type_chosen' && d.refs.includes('blocks.0')
		);
		expect(chosen?.evidence).toMatchObject({ weeks: 16, startsOn: lifter.blocks[0]!.startsOn });
		expect(chosen?.why).toContain('Accumulation carries on into the run-up');

		const hybrid = plan(SCENARIOS.hybrid(), {
			continuity: { phase: 'marathon_base', weeksDone: 2 }
		});
		expect(road(hybrid.blocks).slice(0, 4)).toEqual([
			['marathon_base', 6, false],
			['marathon_build', 8, true],
			['marathon_peak', 3, true],
			['marathon_taper', 3, true]
		]);
	});

	it('plans a run-up too short to build as its taper, at the taper’s factors', () => {
		const { blocks } = plan(M7_SCENARIOS.marathonTaper());
		expect(kinds(blocks[0]!)).toEqual(['taper', 'taper', 'event']);
		expect(blocks[0]!.weeks.map((w) => w.targets.runVolumeFactor)).toEqual([
			0.8,
			0.6,
			weekTargets('event', 0).runVolumeFactor
		]);
	});

	it('plans a re-planned marathon base from the endurance module, its long run in one decision', () => {
		const { blocks, decisions } = plan(M7_SCENARIOS.runnerLifter(), {
			continuity: { phase: 'marathon_base', weeksDone: 0 }
		});
		const [base] = blocks as [BlockSkeleton];
		expect(base).toMatchObject({ type: 'marathon', phase: 'marathon_base', outline: false });
		expect(kinds(base)).not.toContain('baseline');
		expect(base.weeks.every((w) => w.targets.running !== undefined)).toBe(true);
		expect(decisions.filter((d) => d.kind === 'long_run_progressed')).toEqual([
			expect.objectContaining({ ruleKey: 'endurance.long_run', refs: ['blocks.0'] })
		]);
		expect(blocks.find((b) => b.event)).toMatchObject({
			phase: 'marathon_taper',
			endsOn: m7Day(16, 6)
		});
	});
});

describe('the plan budget', () => {
	const longSeason = () => inputOf(M7_SCENARIOS.longSeason());

	it('plans the longest season in at most 10 blocks and 300 decisions, 2 blocks to spare', () => {
		const result = planSeason(longSeason(), START);
		if ('refusal' in result) throw new Error(result.why);
		expect(result.blocks.length).toBeLessThanOrEqual(PLAN_BUDGET.blocks);
		expect(PLAN_BUDGET.schema.blocks - result.blocks.length).toBeGreaterThanOrEqual(2);
		expect(result.decisions.length).toBeLessThanOrEqual(PLAN_BUDGET.decisions);
		// Past the meet, the next event's run-up, each event's road is one outline, then one to the horizon.
		expect(result.blocks.slice(-2).map((b) => [b.name, b.endsOn, b.type])).toEqual([
			['Road to Marathon', m7Day(44, 6), 'marathon'],
			['The season ahead', m7Day(52, 6), 'hypertrophy']
		]);
	});

	it('merges the outlines when the plan keeps 7 past blocks, and stays within 12', () => {
		const result = planSeason(longSeason(), START, { pastBlocks: 7 });
		if ('refusal' in result) throw new Error(result.why);
		expect(7 + result.blocks.length).toBeLessThanOrEqual(PLAN_BUDGET.blocks);
		expect(7 + result.blocks.length).toBeLessThanOrEqual(PLAN_BUDGET.schema.blocks);
		expect(result.blocks.at(-1)!.endsOn).toBe(m7Day(52, 6));
		expect(result.decisions.flatMap((d) => d.refs).every((r) => Number(r.split('.')[1]) >= 7)).toBe(
			true
		);
	});

	it('refuses with too_many_blocks when the past blocks leave no room', () => {
		expect(planSeason(longSeason(), START, { pastBlocks: 11 })).toEqual({
			refusal: 'too_many_blocks',
			why: expect.stringContaining('keeps 11 blocks')
		});
		expect('refusal' in planSeason(longSeason(), START, { pastBlocks: 9 })).toBe(false);
	});

	const every = { ...SCENARIOS, ...M7_SCENARIOS } as Record<string, () => TrainingProfile>;
	it.each(Object.keys(every))(
		'%s: every week’s targets validate, blocks are contiguous whole weeks, and it is deterministic',
		(key) => {
			const result = plan(every[key]!());
			for (const week of result.blocks.flatMap((b) => b.weeks)) {
				expect(validate(periodisedWeekTargetsSchema, week.targets).ok, key).toBe(true);
			}
			const program: ProgramPlan = {
				title: 'Season',
				startsOn: START,
				firstPlannedDay: START,
				blocks: toBlockPlans(result.blocks),
				decisions: result.decisions
			};
			expect(validate(programPlanSchema, program)).toEqual({ ok: true, data: program });
			expect(result.decisions.length).toBeLessThanOrEqual(PLAN_BUDGET.decisions);
			expect(plan(every[key]!())).toEqual(result);
		}
	);
});

describe('the road rules', () => {
	it('registers every road rule, and the season cites only registered keys', () => {
		const road = [...RULE_BY_ID.values()].filter((r) => r.area === 'road');
		expect(road.map((r) => r.id)).toEqual([
			'road.block_length',
			'road.horizon',
			'road.outline_phases',
			'road.first_program',
			'road.taper_guard',
			'road.plan_budget',
			'road.decision_grain',
			'road.season',
			'road.block_plans'
		]);
		expect(RULE_BY_ID.get('road.plan_budget')).toMatchObject({
			kind: 'constant',
			values: PLAN_BUDGET
		});
		const cited = [...staticRuleKeys(['src/lib/domain/programming/periodisation/season.ts'])];
		expect(cited.length).toBeGreaterThan(3);
		for (const key of cited) expect(RULE_BY_ID.has(key), key).toBe(true);
	});
});
