/**
 * generate.ts: the stage list runs in its documented order and each later stage runs its own
 * implementation; every scenario composes into a plan the contract accepts; the minimal profile gets
 * one default_assumed decision per assumption; the same input gives byte-identical JSON.
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
import { SCENARIO_START, SCENARIOS, scenarioDay } from './scenarios';
import { demandIn } from './stage';
import type { Draft } from './stage';
import { loads } from './stages/loads';
import { placement } from './stages/placement';
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
		'volume',
		'loads',
		'progression',
		'timefit'
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
		expect(drafts[0]).toEqual({ demand: null, blocks: [] });
		expect(drafts[1]!.demand?.budget.trainingDays).toBe(3);
		expect(drafts[2]!.blocks).toHaveLength(1);
	});

	it.each(Object.entries({ strength, volume, loads, progression, placement, timefit }))(
		'runs the %s stage of its own',
		(name, run) => {
			expect(STAGES.find((s) => s.name === name)?.run).toBe(run);
		}
	);

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
		expect(plan.blocks.map((b) => b.weeks.length)).toEqual([5]);
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
			'day_allocation'
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
