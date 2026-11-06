/**
 * blocks.ts: the first block's shape with no event, a near event and a marathon; how two dated
 * events interact in either priority order; tapers for events inside the block and notes for
 * events beyond it; and the defaults and paused goals as decisions.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../exercises/index';
import type { Goal, TrainingProfile } from '../profile/types';
import type { BlockPlan } from '../training/types';
import { planFirstBlock } from './blocks';
import { DecisionLog } from './decisions';
import { buildProgrammingInput } from './input';
import { SCENARIO_START, SCENARIOS, scenarioDay } from './scenarios';

const RACE_DAY = scenarioDay(20, 6);
const FIGHT_DAY = scenarioDay(5, 5);

function plan(profile: TrainingProfile) {
	const input = buildProgrammingInput(profile, { catalogue: CATALOGUE });
	const log = new DecisionLog();
	const blocks = planFirstBlock(input, SCENARIO_START, log);
	return { input, blocks, decisions: log.list() };
}

const withGoals = (key: keyof typeof SCENARIOS, goals: (p: TrainingProfile) => Goal[]) => {
	const p = SCENARIOS[key]();
	return { ...p, goals: goals(p) };
};

const dated = (n: number, title: string, eventDate: string, priority: number): Goal => ({
	...SCENARIOS.minimal().goals[0]!,
	id: `00000000-0000-4000-8000-00000000090${n}`,
	kind: 'event',
	title,
	disciplines: ['running'],
	eventType: 'Race',
	eventDate,
	priority
});

const kinds = (block: BlockPlan) => block.weeks.map((w) => w.kind);
const weeksIn = (block: BlockPlan) =>
	(Date.parse(block.endsOn) - Date.parse(block.startsOn) + 86_400_000) / (7 * 86_400_000);
const shape = (blocks: BlockPlan[]) => blocks.map((b) => [b.phase, weeksIn(b), b.outline]);

describe('the first block', () => {
	it('with no event: a baseline week, 3 accumulation weeks and a deload, with no outline', () => {
		const { blocks, decisions, input } = plan(SCENARIOS.minimal());
		expect(blocks).toHaveLength(1);
		const [block] = blocks as [BlockPlan];
		expect(block).toMatchObject({
			phase: 'accumulation',
			name: 'Accumulation',
			startsOn: SCENARIO_START,
			endsOn: scenarioDay(5, 6),
			outline: false,
			goalRefs: input.refs.goals
		});
		expect(kinds(block)).toEqual([
			'baseline',
			'accumulation',
			'accumulation',
			'accumulation',
			'deload'
		]);
		expect(block.weeks.map((w) => [w.startsOn, w.endsOn])).toEqual(
			[1, 2, 3, 4, 5].map((n) => [scenarioDay(n, 0), scenarioDay(n, 6)])
		);
		expect(block.weeks.every((w) => w.sessions.length === 0)).toBe(true);
		expect(decisions.filter((d) => d.kind === 'block_structure')).toEqual([
			expect.objectContaining({
				ruleKey: 'blocks.default',
				refs: ['blocks.0'],
				summary: 'First block: baseline week, 3 accumulation weeks, deload week'
			})
		]);
	});

	it('caps week 1 at RPE 7, builds week on week and deloads with less volume', () => {
		const [block] = plan(SCENARIOS.minimal()).blocks as [BlockPlan];
		const [baseline, ...rest] = block.weeks.map((w) => w.targets);
		const deload = rest.pop()!;
		expect(baseline!.rpeCap).toBeLessThanOrEqual(7);
		const caps = rest.map((t) => t.rpeCap);
		expect(caps).toEqual([...caps].sort((a, b) => a - b));
		expect(caps[0]).toBeGreaterThan(baseline!.rpeCap);
		for (const week of [baseline!, ...rest]) {
			expect(deload.volumeFactor).toBeLessThan(week.volumeFactor);
			expect(deload.runVolumeFactor).toBeLessThan(week.runVolumeFactor);
			expect(deload.rpeCap).toBeLessThan(week.rpeCap);
		}
		// Running grows by at most 10 % a week.
		const run = [baseline!, ...rest].map((t) => t.runVolumeFactor);
		run.slice(1).forEach((r, i) => expect(r / run[i]!).toBeLessThanOrEqual(1.1 + 1e-9));
	});

	it('builds straight to a fight in 5 weeks and tapers in its week', () => {
		const { blocks, decisions } = plan(withGoals('journey', (p) => [p.goals[0]!, p.goals[2]!]));
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			phase: 'realization',
			name: 'Build to Fight',
			endsOn: scenarioDay(5, 6)
		});
		expect(kinds(blocks[0]!)).toEqual(['baseline', 'build', 'build', 'build', 'taper']);
		expect(blocks[0]!.weeks[0]!.targets.rpeCap).toBeLessThanOrEqual(7);
		expect(decisions.find((d) => d.kind === 'block_structure')).toMatchObject({
			ruleKey: 'blocks.short_event',
			why: expect.stringContaining(`Fight on ${FIGHT_DAY} is under 6 weeks away`)
		});
		expect(decisions.filter((d) => d.kind === 'event_taper')).toEqual([
			expect.objectContaining({ refs: ['blocks.0.weeks.4'], summary: 'Taper before Fight' })
		]);
	});

	it('makes a marathon in 20 weeks a marathon base, then outlines build, peak and taper to race day', () => {
		const { blocks, decisions, input } = plan(SCENARIOS.hybrid());
		expect(shape(blocks)).toEqual([
			['marathon_base', 5, false],
			['marathon_build', 9, true],
			['marathon_peak', 3, true],
			['marathon_taper', 3, true]
		]);
		expect(kinds(blocks[0]!)).toEqual([
			'baseline',
			'accumulation',
			'accumulation',
			'accumulation',
			'deload'
		]);
		blocks.slice(1).forEach((b, i) => {
			expect(Date.parse(b.startsOn) - Date.parse(blocks[i]!.endsOn)).toBe(86_400_000);
			expect(b).toMatchObject({ weeks: [], goalRefs: [input.refs.goals[0]] });
		});
		expect(blocks.at(-1)!.endsOn).toBe(RACE_DAY);
		expect(decisions.filter((d) => d.kind === 'block_structure').map((d) => d.ruleKey)).toEqual([
			'blocks.marathon',
			'blocks.outline'
		]);
		expect(decisions.find((d) => d.ruleKey === 'blocks.outline')).toMatchObject({
			refs: ['blocks.1'],
			summary:
				'Outline to Marathon: marathon build 9 weeks, marathon peak 3 weeks, marathon taper 3 weeks',
			why: expect.stringContaining(`It ends with Marathon on ${RACE_DAY}`)
		});
	});

	it('tapers a half marathon for two weeks', () => {
		const half = withGoals('hybrid', (p) => [{ ...p.goals[0]!, eventType: 'Half marathon' }]);
		expect(shape(plan(half).blocks).slice(1)).toEqual([
			['marathon_build', 11, true],
			['marathon_peak', 2, true],
			['marathon_taper', 2, true]
		]);
	});

	it('outlines a powerlifting meet in 16 weeks: build, peak and a week’s taper', () => {
		const { blocks } = plan(SCENARIOS.powerlifter());
		expect(shape(blocks)).toEqual([
			['accumulation', 5, false],
			['intensification', 8, true],
			['realization', 2, true],
			['taper', 1, true]
		]);
		expect(blocks.at(-1)!.endsOn).toBe(scenarioDay(16, 6));
	});
});

describe('two dated events', () => {
	it('lets a fight in 5 weeks shape the block, then outlines the marathon after it', () => {
		const { blocks, decisions, input } = plan(SCENARIOS.journey());
		expect(shape(blocks)).toEqual([
			['realization', 5, false],
			['marathon_base', 4, true],
			['marathon_build', 5, true],
			['marathon_peak', 3, true],
			['marathon_taper', 3, true]
		]);
		expect(kinds(blocks[0]!)).toEqual(['baseline', 'build', 'build', 'build', 'taper']);
		expect(blocks[0]!.goalRefs).toEqual(input.refs.goals);
		expect(blocks.at(-1)!.endsOn).toBe(RACE_DAY);
		expect(blocks.slice(1).every((b) => b.goalRefs[0] === input.refs.goals[1])).toBe(true);
		const words = decisions.map((d) => d.why).join(' ');
		expect(decisions.find((d) => d.kind === 'event_taper')?.summary).toBe('Taper before Fight');
		expect(words).toContain(`Fight on ${FIGHT_DAY}`);
		expect(words).toContain(`It ends with Marathon on ${RACE_DAY}`);
	});

	it('lets a higher-ranked marathon shape a marathon base whose last week tapers for the fight', () => {
		const reversed = withGoals('journey', ({ goals: [fight, marathon, strength] }) => [
			{ ...marathon!, priority: 1 },
			{ ...fight!, priority: 2 },
			strength!
		]);
		const { blocks, decisions } = plan(reversed);
		expect(shape(blocks)).toEqual([
			['marathon_base', 5, false],
			['marathon_build', 9, true],
			['marathon_peak', 3, true],
			['marathon_taper', 3, true]
		]);
		expect(kinds(blocks[0]!)).toEqual([
			'baseline',
			'accumulation',
			'accumulation',
			'accumulation',
			'taper'
		]);
		expect(decisions.filter((d) => d.kind === 'event_taper')).toEqual([
			expect.objectContaining({
				ruleKey: 'blocks.event_taper',
				refs: ['blocks.0.weeks.4'],
				why: expect.stringContaining(`Fight on ${FIGHT_DAY} falls inside the first block`)
			})
		]);
		expect(decisions.find((d) => d.ruleKey === 'blocks.marathon')?.why).toContain(
			`Marathon on ${RACE_DAY} is your top dated goal`
		);
	});

	it('tapers in the week holding most of the seven days before an event, never in week 1', () => {
		const tapered = (eventDate: string) =>
			plan(withGoals('hybrid', (p) => [...p.goals, dated(1, 'Race', eventDate, 4)]));
		// A Monday race tapers in the week before; a Friday one in its own week.
		expect(kinds(tapered(scenarioDay(4, 0)).blocks[0]!)).toEqual([
			'baseline',
			'accumulation',
			'taper',
			'accumulation',
			'deload'
		]);
		expect(kinds(tapered(scenarioDay(3, 4)).blocks[0]!)[2]).toBe('taper');
		expect(kinds(tapered(scenarioDay(3, 3)).blocks[0]!)[1]).toBe('taper');
		// The building weeks keep their steps around the taper.
		const [, , , fourth] = tapered(scenarioDay(4, 0)).blocks[0]!.weeks;
		expect(fourth!.targets.rpeCap).toBe(8);
		const early = tapered(scenarioDay(2, 1));
		expect(kinds(early.blocks[0]!)).toEqual([
			'baseline',
			'accumulation',
			'accumulation',
			'accumulation',
			'deload'
		]);
		expect(early.decisions.filter((d) => d.kind === 'event_taper')).toEqual([]);
	});

	it('notes an event beyond the first block on the outline block it falls in', () => {
		const { blocks, decisions } = plan(
			withGoals('hybrid', (p) => [
				...p.goals,
				dated(1, 'City 10K', scenarioDay(12, 6), 4),
				dated(2, 'Autumn 10K', scenarioDay(30, 6), 5)
			])
		);
		const build = blocks.find((b) => b.phase === 'marathon_build')!;
		expect(build.goalRefs).toEqual([
			'00000000-0000-4000-8000-000000000101',
			'00000000-0000-4000-8000-000000000901'
		]);
		expect(blocks.at(-1)!.endsOn).toBe(RACE_DAY);
		expect(decisions.find((d) => d.ruleKey === 'blocks.outline')?.why).toContain(
			`City 10K on ${scenarioDay(12, 6)} falls in its marathon build, so it is noted there. Autumn 10K on ${scenarioDay(30, 6)} comes after it, so it is planned later.`
		);
	});

	it('ignores an event already past', () => {
		const past = withGoals('minimal', (p) => [dated(1, 'Old race', '2026-11-01', 1), p.goals[0]!]);
		expect(shape(plan(past).blocks)).toEqual([['accumulation', 5, false]]);
	});
});

describe('defaults and paused goals', () => {
	it('records each assumption as a default_assumed decision, in the input’s order', () => {
		const { input, decisions } = plan(SCENARIOS.minimal());
		const assumed = decisions.filter((d) => d.kind === 'default_assumed');
		expect(assumed.map((d) => [d.ruleKey, d.evidence.field])).toEqual(
			input.assumptions.map((a) => [a.ruleKey, a.field])
		);
		expect(assumed[0]).toMatchObject({
			summary: 'Assumed any day of the week',
			why: expect.stringContaining('Change it in Profile → ')
		});
	});

	it('leaves a paused goal out with a goal_excluded decision', () => {
		const p = withGoals('journey', ({ goals: g }) => [
			g[0]!,
			g[1]!,
			{ ...g[2]!, status: 'paused' }
		]);
		const { decisions, blocks, input } = plan(p);
		expect(decisions.filter((d) => d.kind === 'goal_excluded')).toEqual([
			expect.objectContaining({ ruleKey: 'goals.paused', summary: 'Keep strength is paused' })
		]);
		expect(blocks[0]!.goalRefs).toEqual(input.refs.goals);
		expect(blocks[0]!.goalRefs).not.toContain(input.refs.paused[0]);
	});

	it('plans every paused goal at maintenance when all are paused, saying so once', () => {
		const p = withGoals('minimal', ({ goals }) =>
			goals.map((goal) => ({ ...goal, status: 'paused' as const }))
		);
		const { decisions, blocks, input } = plan(p);
		expect(blocks[0]).toMatchObject({ phase: 'maintenance', goalRefs: input.refs.paused });
		expect(decisions.filter((d) => d.kind === 'goal_excluded')).toEqual([]);
		expect(decisions.map((d) => d.ruleKey)).toContain('defaults.all_goals_paused');
	});
});
