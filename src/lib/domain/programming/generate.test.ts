/**
 * generate.ts: the stage list runs in its documented order and each stage runs its own
 * implementation, phasing before volume and schedule last; every scenario composes into a plan the contract accepts; the minimal profile gets
 * one default_assumed decision per assumption; the same input gives byte-identical JSON, and every
 * scenario's plan is the one hashed before m7-stage-list.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATALOGUE } from '../exercises/index';
import type { TrainingProfile } from '../profile/types';
import { programPlanSchema } from '../training/schemas';
import { validate } from '../validation';
import { loads as loadsTemplates } from './decisions/templates/loads';
import { strength as strengthTemplates } from './decisions/templates/strength';
import { volume as volumeTemplates } from './decisions/templates/volume';
import { GeneratedPlanError, generateProgram, STAGES } from './generate';
import { buildProgrammingInput } from './input';
import { fnv1a64 } from './random';
import { SCENARIO_START, SCENARIOS, scenarioDay } from './scenarios';
import type { ScenarioKey } from './scenarios';
import { demandIn } from './stage';
import type { Draft } from './stage';
import { blocks } from './stages/blocks';
import { demand } from './stages/demand';
import { loads } from './stages/loads';
import { placement } from './stages/placement';
import * as stages from './stages/prepare';
import { progression } from './stages/progression';
import { strength } from './stages/strength';
import { timefit } from './stages/timefit';
import { volume } from './stages/volume';

const OPTIONS = { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START };
const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });
const generate = (profile: TrainingProfile) => generateProgram(inputOf(profile), OPTIONS);

afterEach(() => {
	vi.restoreAllMocks();
});

describe('the stage list', () => {
	const ORDER = [
		'demand',
		'blocks',
		'commitments',
		'strength',
		'running',
		'other',
		'placement',
		'phasing',
		'volume',
		'loads',
		'progression',
		'timefit',
		'schedule'
	];

	it('runs every stage once, in the documented order, each on the draft the one before returned', () => {
		const ran: string[] = [];
		const drafts: Draft[] = [];
		for (const stage of STAGES) {
			const run = stage.run;
			vi.spyOn(stage, 'run').mockImplementation((draft, context) => {
				ran.push(stage.name);
				drafts.push(draft);
				return run(draft, context);
			});
		}
		generate(SCENARIOS.minimal());
		expect(STAGES.map((s) => s.name)).toEqual(ORDER);
		expect(ran).toEqual(ORDER);
		// The first draft carries prepare's season; the blocks stage plans it, outlines included.
		expect(drafts[0]).toMatchObject({ demand: null, blocks: [] });
		expect(drafts[0]!.periodisation?.season.blocks).toHaveLength(4);
		expect(drafts[1]!.demand?.budget.trainingDays).toBe(3);
		expect(drafts[2]!.blocks.map((b) => b.weeks.length)).toEqual([5, 0, 0, 0]);
	});

	it.each(
		Object.entries({ demand, blocks, strength, volume, loads, progression, placement, timefit })
	)('runs the %s stage of its own', (name, run) => {
		expect(STAGES.find((s) => s.name === name)?.run).toBe(run);
	});

	it('runs phasing after placement and before volume, which counts the hard sets it sets, and schedule last', () => {
		const names = STAGES.map((s) => s.name);
		expect(names.indexOf('phasing')).toBe(names.indexOf('placement') + 1);
		expect(names.indexOf('volume')).toBe(names.indexOf('phasing') + 1);
		expect(names.at(-1)).toBe('schedule');
	});

	it('gives the demand to the stages after it, and refuses to before the demand stage', () => {
		expect(() => demandIn({ demand: null, blocks: [] })).toThrow('The demand stage runs first');
	});
});

describe('generateProgram', () => {
	it('gives the minimal profile a valid first block and one default_assumed per assumption', () => {
		const input = inputOf(SCENARIOS.minimal());
		const plan = generateProgram(input, OPTIONS);
		expect(validate(programPlanSchema, plan)).toEqual({ ok: true, data: plan });
		expect(plan).toMatchObject({
			title: 'Get stronger',
			startsOn: SCENARIO_START,
			firstPlannedDay: SCENARIO_START
		});
		// M3's first block, then the season's outlines: accumulation, intensification, realization.
		expect(plan.blocks.map((b) => b.weeks.length)).toEqual([5, 0, 0, 0]);
		expect(
			plan.decisions.filter((d) => d.kind === 'default_assumed').map((d) => d.ruleKey)
		).toEqual(input.assumptions.map((a) => a.ruleKey));
		const ownKinds: string[] = [
			...Object.keys(strengthTemplates),
			...Object.keys(volumeTemplates),
			...Object.keys(loadsTemplates)
		];
		expect(plan.decisions.map((d) => d.kind).filter((k) => !ownKinds.includes(k))).toEqual([
			'program_purpose',
			'block_structure',
			...input.assumptions.map(() => 'default_assumed'),
			'day_allocation',
			// The season's: who leads the first block, and the block type it chose.
			'priority_resolved',
			'block_type_chosen'
		]);
		expect(plan.decisions.filter((d) => d.kind === 'split_chosen')).toHaveLength(1);
	});

	it.each(Object.keys(SCENARIOS) as (keyof typeof SCENARIOS)[])(
		'composes the %s scenario into a plan the contract accepts',
		(key) => {
			const plan = generate(SCENARIOS[key]());
			expect(validate(programPlanSchema, plan)).toEqual({ ok: true, data: plan });
			expect(plan.blocks[0]!.weeks[0]).toMatchObject({
				kind: 'baseline',
				startsOn: SCENARIO_START
			});
			expect(plan.blocks[0]!.weeks[0]!.targets.rpeCap).toBeLessThanOrEqual(7);
			for (const d of plan.decisions) expect(d.why.trim()).not.toBe('');
		}
	);

	it('names the journey’s two events and every paused goal in its decisions', () => {
		const p = SCENARIOS.journey();
		p.goals.push({
			...p.goals[2]!,
			id: '00000000-0000-4000-8000-000000000199',
			title: 'Bulk up',
			status: 'paused',
			priority: 4
		});
		const plan = generate(p);
		const words = plan.decisions.map((d) => `${d.summary} ${d.why}`).join('\n');
		expect(words).toContain('Fight on');
		expect(words).toContain('Marathon on');
		expect(plan.decisions.filter((d) => d.kind === 'goal_excluded').map((d) => d.summary)).toEqual([
			'Bulk up is paused'
		]);
		expect(plan.title).toBe('Fight · Marathon · Keep strength');
	});

	it('gives the same input byte-identical JSON, however its profile was copied', () => {
		const once = JSON.stringify(generate(SCENARIOS.journey()));
		expect(JSON.stringify(generate(SCENARIOS.journey()))).toBe(once);
		const input = inputOf(SCENARIOS.journey());
		expect(JSON.stringify(generateProgram(structuredClone(input), OPTIONS))).toBe(once);
	});

	describe('checks its plan against the contract before returning it', () => {
		/** The last stage, made to break the plan with `breakIt` after it runs. */
		function breakLastStage(breakIt: (draft: Draft) => Draft) {
			const last = STAGES.at(-1)!;
			const run = last.run;
			vi.spyOn(last, 'run').mockImplementation((draft, context) => breakIt(run(draft, context)));
		}
		const inWeek1 = (
			draft: Draft,
			edit: (week: Draft['blocks'][number]['weeks'][number]) => void
		) => {
			const blocks = structuredClone(draft.blocks);
			edit(blocks[0]!.weeks[0]!);
			return { ...draft, blocks };
		};

		it('refuses a session before a ‘this_week’ start’s first planned day', () => {
			const thursday = scenarioDay(1, 3);
			breakLastStage((draft) =>
				inWeek1(draft, (week) => {
					week.sessions.push({ ...week.sessions[0]!, date: scenarioDay(1, 1) });
				})
			);
			const input = inputOf(SCENARIOS.beginner());
			const attempt = () => generateProgram(input, { ...OPTIONS, firstPlannedDay: thursday });
			expect(attempt).toThrow(GeneratedPlanError);
			expect(attempt).toThrow(
				'The generated plan breaks the contract at blocks.0.weeks.0.sessions.1.date: Not before the first planned day'
			);
		});

		it('lists every path it refuses, such as sessions out of their week', () => {
			breakLastStage((draft) =>
				inWeek1(draft, (week) => {
					week.sessions[0]!.date = scenarioDay(2, 0);
					week.sessions[1]!.date = scenarioDay(2, 2);
				})
			);
			let error: unknown;
			try {
				generate(SCENARIOS.minimal());
			} catch (e) {
				error = e;
			}
			expect(error).toBeInstanceOf(GeneratedPlanError);
			expect((error as GeneratedPlanError).errors).toEqual({
				'blocks.0.weeks.0.sessions.0.date': 'In its week',
				'blocks.0.weeks.0.sessions.1.date': 'In its week'
			});
		});
	});

	it('keeps the start dates it was given and refuses a week 1 that is not a Monday', () => {
		const input = inputOf(SCENARIOS.minimal());
		const thursday = scenarioDay(1, 3);
		expect(generateProgram(input, { ...OPTIONS, firstPlannedDay: thursday }).firstPlannedDay).toBe(
			thursday
		);
		expect(() => generateProgram(input, { startsOn: thursday, firstPlannedDay: thursday })).toThrow(
			new RangeError(`Week 1 starts on a Monday: ${thursday}`)
		);
		for (const outside of [scenarioDay(2, 0), scenarioDay(0, 6)]) {
			expect(() => generateProgram(input, { ...OPTIONS, firstPlannedDay: outside })).toThrow(
				new RangeError(`Not a day of week 1: ${outside}`)
			);
		}
	});
});

/**
 * Every scenario's plan as JSON, the bytes a version stores, hashed on a Monday and a Thursday start
 * before m7-stage-list moved the demand and blocks stages and added prepare, phasing and schedule.
 * With prepare as the identity (no season), M3's stages still plan these bytes exactly: the M7
 * hunks in demand.ts, splits.ts and input.ts change nothing without a season. generator-running
 * ('perfo-programming/5') changed the plans with runs, hybrid's and journey's: their paces come from
 * paces.ts's VDOT, so their pinned hashes are its.
 */
const GOLDEN: Record<ScenarioKey, readonly [monday: string, thursday: string]> = {
	beginner: ['d4bfc183ab8ee435', 'e76eed0b701d71ea'],
	powerlifter: ['7002151f6b51da7b', 'ce338ae4b7af709d'],
	hybrid: ['f8bc80dd615645ed', '3100524562860ed5'],
	injuredShoulder: ['1372ab5296078226', '48ee5ba593935dd7'],
	dumbbellsOnly: ['71015477f3f97476', '92907395e75da37b'],
	journey: ['550aa8d3fa4c7208', 'c323c0f6f372651f'],
	minimal: ['c3e4d72addb45c7a', '57bb88bd394355e1']
};

/**
 * The same plans with the season (generator-season) and every week repaired by the schedule stage
 * (generator-schedule, GENERATOR_ID 'perfo-programming/3', which changed hybrid's), and each
 * week's prescriptions by its block type (generator-phasing, 'perfo-programming/4': hybrid's
 * secondary strength held to the lower half of its band), and runs from current fitness
 * (generator-running, 'perfo-programming/5': hybrid's and journey's paces from their VDOT), and
 * Muay Thai from the fight camp (generator-combat, 'perfo-programming/6': journey's camp weeks get
 * their sparring and conditioning); a later GENERATOR_ID bump changes them, and its PR lists each.
 */
const GOLDEN_SEASON: Record<ScenarioKey, readonly [monday: string, thursday: string]> = {
	beginner: ['40ac8a97f8ac8304', 'afbafd92042977bf'],
	powerlifter: ['53368325fc4eeb18', '7cce2ec2cd815ba0'],
	hybrid: ['4b442a4bbffe9dba', '6e5143cbd95d1af0'],
	injuredShoulder: ['a4e42532f422ef13', 'e020e654173b406a'],
	dumbbellsOnly: ['7eb70d064378cab5', '2ebb5a975014b49c'],
	journey: ['281fd08bbc77905c', '9d3d00aeebff9b16'],
	minimal: ['69abd4d5ab6fd927', '1cb83a5371a0118c']
};

const hashesOf = (key: ScenarioKey) => {
	const input = inputOf(SCENARIOS[key]());
	return [OPTIONS, { ...OPTIONS, firstPlannedDay: scenarioDay(1, 3) }].map((start) =>
		fnv1a64(JSON.stringify(generateProgram(input, start)))
	);
};

describe('byte-identical plans', () => {
	it.each(Object.keys(GOLDEN) as ScenarioKey[])(
		'%s: with no season, the plan is byte for byte the one from before the stage list moved',
		(key) => {
			vi.spyOn(stages, 'prepare').mockImplementation((input) => ({ input, periodisation: null }));
			// M3's stages alone: the schedule stage (generator-schedule) is M7's.
			vi.spyOn(
				STAGES.find((s) => s.name === 'schedule')!,
				'run'
			).mockImplementation((d) => d);
			expect(hashesOf(key)).toEqual(GOLDEN[key]);
		}
	);

	it.each(Object.keys(GOLDEN_SEASON) as ScenarioKey[])(
		'%s: with the season, the plan is byte for byte the one generator-season pinned',
		(key) => {
			expect(hashesOf(key)).toEqual(GOLDEN_SEASON[key]);
		}
	);
});
