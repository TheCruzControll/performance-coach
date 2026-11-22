/**
 * generator-season: new programs follow M7's priorities, season and doses (prepare, the blocks
 * stage, and the demand, splits and input hunks), each choice recorded as a decision; every goal
 * paused gives M3's maintenance plan; the stored snapshot stays M3's input; the plan budget holds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDays } from '../calendar';
import { CATALOGUE } from '../exercises/index';
import type { TrainingProfile } from '../profile/types';
import { programPlanSchema } from '../training/schemas';
import type { ProgramPlan } from '../training/types';
import { validate } from '../validation';
import { DecisionLog } from './decisions';
import { allocateWeek, generatedFor, weekBudget } from './demand';
import { generateProgram, STAGES } from './generate';
import { buildProgrammingInput } from './input';
import { M7_SCENARIOS, m7Day } from './periodisation/scenarios';
import type { M7ScenarioKey } from './periodisation/scenarios';
import { catalogueDigest, fingerprint } from './random';
import { RULE_BY_ID } from './rules/registry/index';
import { PLAN_BUDGET } from './rules/road';
import { STYLES } from './rules/strength';
import { SCENARIO_START, SCENARIOS } from './scenarios';
import type { ScenarioKey } from './scenarios';
import { chooseSplit } from './splits';
import { SCHEDULED_DELOAD_KEY } from './stages/blocks';
import { demand } from './stages/demand';
import * as stages from './stages/prepare';

const OPTIONS = { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START };
const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });
const generate = (profile: TrainingProfile) => generateProgram(inputOf(profile), OPTIONS);
const prepared = (profile: TrainingProfile) =>
	stages.prepare(inputOf(profile), OPTIONS, new DecisionLog());

/** M3's plan: generateProgram with prepare as the identity, so no season is planned. */
function m3Plan(profile: TrainingProfile): ProgramPlan {
	const spy = vi.spyOn(stages, 'prepare').mockImplementation((input) => ({
		input,
		periodisation: null
	}));
	try {
		return generate(profile);
	} finally {
		spy.mockRestore();
	}
}

const ALL: [string, () => TrainingProfile][] = [
	...(Object.keys(SCENARIOS) as ScenarioKey[]).map((k): [string, () => TrainingProfile] => [
		k,
		SCENARIOS[k]
	]),
	...(Object.keys(M7_SCENARIOS) as M7ScenarioKey[]).map((k): [string, () => TrainingProfile] => [
		k,
		M7_SCENARIOS[k]
	])
];

afterEach(() => {
	vi.restoreAllMocks();
});

describe('generateProgram on multiGoal (S1)', () => {
	const plan = generate(M7_SCENARIOS.multiGoal());
	const fight = m7Day(10, 5);
	const marathon = m7Day(24, 6);

	it('leads its blocks to each event: fight camp, recovery, then the marathon’s build, peak and taper', () => {
		expect(plan.blocks.map((b) => b.phase)).toEqual([
			'fight_camp',
			'recovery',
			'marathon_base',
			'marathon_build',
			'marathon_peak',
			'marathon_taper',
			'recovery',
			'hypertrophy'
		]);
		const [camp] = plan.blocks;
		expect(camp!.weeks.at(-1)).toMatchObject({ kind: 'event', endsOn: addDays(fight, 1) });
		expect(plan.blocks[5]!.endsOn).toBe(marathon);
		expect(plan.blocks.slice(1).every((b) => b.outline && b.weeks.length === 0)).toBe(true);
		expect(validate(programPlanSchema, plan)).toEqual({ ok: true, data: plan });
	});

	it('caps the dosed strength days in the allocation', () => {
		const { input, periodisation } = prepared(M7_SCENARIOS.multiGoal());
		const doses = periodisation!.dosesByWeek[0]!.doses.map((d) => `${d.goal.title}:${d.stream}`);
		expect(doses).toEqual(['Build muscle:hypertrophy', 'Keep strength:strength']);
		const draft = demand(
			{ demand: null, blocks: [], periodisation: periodisation! },
			{
				input,
				options: OPTIONS,
				log: new DecisionLog()
			}
		);
		const unheld = allocateWeek(input, weekBudget(input), new DecisionLog());
		const held = draft.demand!.allocation;
		// Held at its dose, the strength stream stops at 2: the runs keep their 3, and the week
		// needs one second session on a commitment day fewer.
		expect([generatedFor(unheld, 'strength'), generatedFor(held, 'strength')]).toEqual([3, 2]);
		expect(generatedFor(held, 'runs')).toBe(generatedFor(unheld, 'runs'));
		expect([unheld.doubles, held.doubles]).toEqual([2, 1]);
		const days = plan.decisions.find((d) => d.kind === 'day_allocation')!;
		expect(days.why).toContain('3 runs for Marathon, 2 strength sessions for Build muscle');
	});

	it('trains keep strength and build muscle on M3’s maintenance split and style', () => {
		const { input } = prepared(M7_SCENARIOS.multiGoal());
		const split = chooseSplit(input, 2);
		expect(split).toMatchObject({ layout: 'maintenance', maintenance: true });
		expect(split.prescription).toBe(STYLES.maintenance);
		expect(plan.decisions.find((d) => d.kind === 'split_chosen')?.ruleKey).toBe(
			'strength.maintenance'
		);
		const doses = plan.decisions.filter((d) => d.kind === 'maintenance_dose');
		const refs = inputOf(M7_SCENARIOS.multiGoal()).refs.goals;
		expect(doses.map((d) => [d.evidence.goal, d.evidence.stream, d.evidence.mode])).toEqual([
			['Build muscle', 'hypertrophy', 'maintenance'],
			['Keep strength', 'strength', 'maintenance'],
			['Marathon', 'runs', 'maintenance']
		]);
		expect(doses.map((d) => d.evidence.goalRef)).toEqual([refs[2], refs[3], refs[1]]);
	});

	it('names the fight’s date in its priority_resolved, with the leader’s ref and mode', () => {
		const resolved = plan.decisions.filter(
			(d) => d.kind === 'priority_resolved' && d.refs.includes('blocks.0')
		);
		expect(resolved.map((d) => [d.ruleKey, d.evidence.from, d.evidence.until])).toEqual([
			['priority.rank_weights', SCENARIO_START, m7Day(2, 6)],
			['priority.lead', m7Day(3, 0), m7Day(10, 6)]
		]);
		expect(resolved[1]!.why).toContain(`Muay Thai fight on ${fight}`);
		for (const d of resolved) {
			expect(d.evidence).toMatchObject({
				goalRef: inputOf(M7_SCENARIOS.multiGoal()).refs.goals[0],
				mode: 'primary'
			});
		}
	});

	it('schedules the camp’s deload as a decision, and gives every decision a why', () => {
		const deloads = plan.decisions.filter((d) => d.kind === 'deload_scheduled');
		expect(deloads.map((d) => [d.ruleKey, d.refs])).toEqual([
			[SCHEDULED_DELOAD_KEY, ['blocks.0.weeks.4']]
		]);
		expect(plan.blocks[0]!.weeks[4]!.kind).toBe('deload');
		for (const d of plan.decisions) expect(d.why.trim(), d.kind).not.toBe('');
	});
});

describe('modes and parity', () => {
	it('keeps a secondary strength goal on its own layout and style, where M3’s rule alone picks maintenance', () => {
		const raw = inputOf(M7_SCENARIOS.runnerLifter());
		expect(chooseSplit(raw, 2).layout).toBe('maintenance');
		const { input } = prepared(M7_SCENARIOS.runnerLifter());
		expect(input.modes).toEqual({
			[raw.refs.goals[0]!]: 'primary',
			[raw.refs.goals[1]!]: 'secondary'
		});
		const split = chooseSplit(input, 2);
		expect(split).toMatchObject({ layout: 'full_body', maintenance: false });
		expect(split.prescription).not.toBe(STYLES.maintenance);
		const plan = generate(M7_SCENARIOS.runnerLifter());
		expect(plan.decisions.find((d) => d.kind === 'split_chosen')?.ruleKey).toBe(
			'strength.full_body'
		);
		// A strength goal held at maintenance by modes still gets the maintenance split.
		const held = {
			...input,
			modes: { ...input.modes, [raw.refs.goals[1]!]: 'maintenance' as const }
		};
		expect(chooseSplit(held, 2).layout).toBe('maintenance');
	});

	it('gives a strength goal held at its dose M3’s maintenance split, even ranked first', () => {
		const { input } = prepared(M7_SCENARIOS.offSeason());
		expect(Object.values(input.modes ?? {})).toEqual(['maintenance', 'maintenance']);
		expect(chooseSplit(input, 2)).toMatchObject({ layout: 'maintenance', maintenance: true });
		const plan = generate(M7_SCENARIOS.offSeason());
		expect(plan.decisions.find((d) => d.kind === 'split_chosen')?.ruleKey).toBe(
			'strength.maintenance'
		);
	});

	it('reorders the goals, their refs and the disciplines by effective priority, the leader first', () => {
		// Strength ranked first, but the marathon in week 16 is inside its 16-week lead window.
		const p = M7_SCENARIOS.runnerLifter();
		p.goals = p.goals.map((g) => ({ ...g, priority: g.title === 'Marathon' ? 2 : 1 }));
		const raw = inputOf(p);
		expect(raw.goals.map((g) => g.title)).toEqual(['Get stronger', 'Marathon']);
		expect(raw.disciplines).toEqual(['strength', 'distance_running']);
		const { input } = stages.prepare(raw, OPTIONS, new DecisionLog());
		expect(input.goals.map((g) => g.title)).toEqual(['Marathon', 'Get stronger']);
		expect(input.disciplines).toEqual(['distance_running', 'strength']);
		expect(input.refs.goals).toEqual([...raw.refs.goals].reverse());
		expect(input.goals).toEqual([...raw.goals].reverse());
		expect(input.modes).toEqual({
			[raw.refs.goals[1]!]: 'primary',
			[raw.refs.goals[0]!]: 'secondary'
		});
	});

	it('gives every goal paused M3’s maintenance plan, apart from its maintenance_dose decisions', () => {
		// As the stages before the schedule stage plan it: that stage (generator-schedule) then
		// repairs each week with the held goals' priorities, which M3's plan has none of.
		vi.spyOn(
			STAGES.find((s) => s.name === 'schedule')!,
			'run'
		).mockImplementation((d) => d);
		const paused = M7_SCENARIOS.allPaused();
		const plan = generate(paused);
		const m3 = m3Plan(paused);
		expect(plan.blocks).toEqual(m3.blocks);
		expect(plan.blocks.map((b) => [b.phase, b.goalRefs])).toEqual([
			['maintenance', inputOf(paused).refs.paused]
		]);
		const doses = plan.decisions.filter((d) => d.kind === 'maintenance_dose');
		expect(plan.decisions.filter((d) => d.kind !== 'maintenance_dose')).toEqual(m3.decisions);
		const refs = inputOf(paused).refs.paused;
		expect(doses.map((d) => [d.ruleKey, d.evidence.goalRef, d.evidence.mode])).toEqual([
			['maintenance.strength', refs[0], 'maintenance'],
			['maintenance.runs', refs[1], 'maintenance']
		]);
		const { periodisation } = prepared(paused);
		expect(periodisation!.season.blocks.map((b) => [b.phase, b.startsOn, b.endsOn])).toEqual([
			['maintenance', m3.blocks[0]!.startsOn, m3.blocks[0]!.endsOn]
		]);
	});

	it('stores buildProgrammingInput’s own input: no modes field, the same fingerprint', () => {
		const input = inputOf(M7_SCENARIOS.multiGoal());
		const before = structuredClone(input);
		const digest = catalogueDigest(CATALOGUE, []);
		generateProgram(input, OPTIONS);
		expect(input).toEqual(before);
		expect('modes' in input).toBe(false);
		expect(fingerprint(input, digest)).toBe(fingerprint(inputOf(M7_SCENARIOS.multiGoal()), digest));
		expect(prepared(M7_SCENARIOS.multiGoal()).input.modes).toBeDefined();
	});
});

describe('the plan budget', () => {
	it('keeps longSeason within PLAN_BUDGET, with at least 40 % of the decision cap to spare', () => {
		const plan = generate(M7_SCENARIOS.longSeason());
		// The season's road: the fight camp first, then outlines to the meet and the marathon.
		expect(plan.blocks[0]!.phase).toBe('fight_camp');
		expect(plan.blocks.map((b) => b.phase)).toEqual(
			expect.arrayContaining(['taper', 'marathon_build'])
		);
		expect(plan.blocks.length).toBeLessThanOrEqual(PLAN_BUDGET.blocks);
		expect(plan.decisions.length).toBeLessThanOrEqual(0.6 * PLAN_BUDGET.decisions);
	});
});

describe('every scenario', () => {
	it.each(ALL)('%s: cites no superseded rule, and passes programPlanSchema', (_, profile) => {
		const plan = generate(profile());
		expect(validate(programPlanSchema, plan)).toEqual({ ok: true, data: plan });
		const superseded = plan.decisions.filter(
			(d) => RULE_BY_ID.get(d.ruleKey)?.status === 'superseded'
		);
		expect(superseded.map((d) => d.ruleKey)).toEqual([]);
	});

	it.each(ALL)('%s: gives the same plan however the profile’s rows are ordered', (_, profile) => {
		const p = profile();
		const shuffled: TrainingProfile = {
			...p,
			goals: [...p.goals].reverse(),
			experience: [...p.experience].reverse(),
			baselines: [...p.baselines].reverse(),
			schedule: { ...p.schedule, commitments: [...p.schedule.commitments].reverse() }
		};
		expect(JSON.stringify(generate(shuffled))).toBe(JSON.stringify(generate(p)));
	});
});
