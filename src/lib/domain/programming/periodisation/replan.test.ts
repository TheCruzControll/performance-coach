/**
 * replan-domain: a re-plan from a Monday regenerates the rest of the block (new priorities, a
 * chosen block), with every eligible exercise kept; every case it cannot plan is refused with its
 * reason. A taper and a deload are refused until m7r/27 plans them.
 */
import { describe, expect, it } from 'vitest';
import { addDays } from '../../calendar';
import { CATALOGUE } from '../../exercises/index';
import type { TrainingProfile } from '../../profile/types';
import type { ReplanDirective } from '../../training/replan';
import { exerciseRefKey } from '../../training/metrics';
import type { BlockPlan, ProgramPlan, StrengthSessionPlan, WeekPlan } from '../../training/types';
import { generateProgram } from '../generate';
import { buildProgrammingInput } from '../input';
import type { ProgrammingInput } from '../input';
import { staticRuleKeys } from '../../../../../scripts/rule-keys';
import { RULE_BY_ID } from '../rules/registry/index';
import { exerciseOf } from '../selection';
import { PLAN_BUDGET } from '../rules/road';
import { SCENARIO_START, SCENARIOS } from '../scenarios';
import { generateReplan, replanSkeleton, replanStart } from './replan';
import type { Replan, ReplanOptions } from './replan';
import { M7_SCENARIOS, m7Day } from './scenarios';
import { taperWeeks } from './taper';

const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });
const generate = (profile: TrainingProfile) =>
	generateProgram(inputOf(profile), { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START });
const RESULTS = { results: [], unit: 'kg' as const };

type Options = Omit<ReplanOptions, 'baseVersionNumber' | 'directive'> & {
	baseVersionNumber?: number;
};

function skeleton(input: ProgrammingInput, directive: ReplanDirective, o: Options) {
	return replanSkeleton(input, { baseVersionNumber: 1, directive, ...o });
}
/** The re-plan, failing the test on a refusal. */
function replan(profile: TrainingProfile, directive: ReplanDirective, o: Options): Replan {
	const input = inputOf(profile);
	const s = skeleton(input, directive, o);
	if ('refusal' in s) throw new Error(`Refused: ${s.why}`);
	return generateReplan(input, s, RESULTS);
}
const refusal = (profile: TrainingProfile, directive: ReplanDirective, o: Options) => {
	const s = skeleton(inputOf(profile), directive, o);
	return 'refusal' in s ? s.refusal : null;
};

const weeksOf = (plan: ProgramPlan) => plan.blocks.flatMap((b) => b.weeks);
const sessionsOf = (plan: ProgramPlan) => weeksOf(plan).flatMap((w) => w.sessions);
const strengthKeys = (block: BlockPlan) =>
	new Set(
		block.weeks.flatMap((w) =>
			w.sessions.flatMap((s) =>
				s.kind === 'strength' ? s.exercises.map((e) => exerciseRefKey(e.exercise)) : []
			)
		)
	);
const goalId = (profile: TrainingProfile, title: RegExp) =>
	profile.goals.find((g) => title.test(g.title))!.id;

const PRIORITIES: ReplanDirective = { kind: 'priorities', cause: 'reorder' };
const HYBRID = SCENARIOS.hybrid();
const CURRENT = generate(HYBRID);
const MARATHON_ON = HYBRID.goals.find((g) => g.kind === 'event')!.eventDate!;

describe('replanStart', () => {
	it('is the next Monday, today on a Monday, past any week with something logged or skipped', () => {
		expect(replanStart(m7Day(2, 3), [])).toBe(m7Day(3, 0));
		expect(replanStart(m7Day(2, 0), [])).toBe(m7Day(2, 0));
		expect(replanStart(m7Day(2, 0), [m7Day(2, 0)])).toBe(m7Day(3, 0));
		expect(replanStart(m7Day(2, 3), [m7Day(2, 1), m7Day(3, 4)])).toBe(m7Day(4, 0));
	});
});

describe('regenerate: new priorities (S8, hybridSwap at week 3)', () => {
	const swap = M7_SCENARIOS.hybridSwap();
	const from = m7Day(3, 0);
	const r = replan(swap, PRIORITIES, { today: from, from, current: CURRENT });
	const strong = goalId(swap, /strong/i);
	const marathon = goalId(swap, /marathon/i);
	const newBlock = r.plan.blocks[1]!;

	it('keeps every week before from, cuts the block across it, and dates every new session from it', () => {
		expect(r.plan.blocks[0]).toEqual({
			...CURRENT.blocks[0],
			endsOn: addDays(from, -1),
			weeks: CURRENT.blocks[0]!.weeks.filter((w) => w.startsOn < from)
		});
		expect(newBlock.startsOn).toBe(from);
		expect(newBlock.weeks.flatMap((w) => w.sessions).every((s) => s.date >= from)).toBe(true);
		expect(r.decisions[0]).toMatchObject({
			kind: 'replanned',
			ruleKey: 'replan.regenerate',
			refs: ['blocks.1']
		});
	});

	it('plans a new leader with the doses swapped, no baseline week, and the race’s taper on its dates', () => {
		const leaders = (decisions: ProgramPlan['decisions']) =>
			decisions.filter((d) => d.kind === 'priority_resolved' && d.evidence.mode === 'primary');
		expect(leaders(CURRENT.decisions)[0]!.evidence).toMatchObject({ goalRef: marathon });
		const first = leaders(r.decisions)[0]!;
		expect(first.evidence).toMatchObject({ goalRef: strong, from });
		expect(String(first.evidence.modes)).toMatch(/^Marathon trains alongside as secondary/);
		expect(String(leaders(CURRENT.decisions)[0]!.evidence.modes)).toMatch(/^Stay strong trains/);
		expect(newBlock.weeks.map((w) => w.kind)).not.toContain('baseline');
		const taper = taperWeeks('marathon', 'primary', MARATHON_ON);
		const block = r.plan.blocks.find((b) => b.phase === 'marathon_taper')!;
		expect([block.startsOn, block.endsOn]).toEqual([
			taper.weeks[0]!.startsOn,
			addDays(MARATHON_ON, 0)
		]);
	});

	it('keeps every still-eligible exercise and rotates none', () => {
		const before = strengthKeys(CURRENT.blocks[0]!);
		const s = skeleton(inputOf(swap), PRIORITIES, { today: from, from, current: CURRENT });
		expect(before.size).toBeGreaterThan(0);
		expect('directives' in s && s.directives).toMatchObject({ rotate: [] });
		expect('directives' in s && s.directives!.keep.map((k) => k.exercise)).toEqual(
			[...before].sort()
		);
		// Each kept exercise the new block holds is recorded as kept, the main lifts among them.
		const held = [...before].filter((key) => strengthKeys(newBlock).has(key));
		expect(held).toEqual(expect.arrayContaining(['back_squat', 'bench_press', 'deadlift']));
		expect(r.decisions.filter((d) => d.kind === 'exercise_kept')).toHaveLength(held.length);
		expect(r.decisions.some((d) => d.kind === 'exercise_rotated')).toBe(false);
	});

	it('from the current block’s start replaces that block, with no zero-week block', () => {
		const at = CURRENT.blocks[1]!.startsOn;
		const p = replan(swap, PRIORITIES, { today: at, from: at, current: CURRENT }).plan;
		expect(p.blocks[0]).toEqual(CURRENT.blocks[0]);
		expect(p.blocks[1]!.startsOn).toBe(at);
		expect(p.blocks.every((b) => b.endsOn > b.startsOn)).toBe(true);
	});

	it('from the program’s start regenerates it all through generateProgram', () => {
		const p = replan(swap, PRIORITIES, {
			today: m7Day(0, 3),
			from: SCENARIO_START,
			current: CURRENT
		});
		const fresh = generate(swap);
		expect(p.plan.blocks).toEqual(fresh.blocks);
		expect(p.decisions.slice(1)).toEqual(fresh.decisions);
		expect(p.decisions[0]!.refs).toEqual(['blocks.0']);
	});

	it('from before a program that has not started yet re-plans it from its own start', () => {
		const early = addDays(SCENARIO_START, -14);
		const p = replan(swap, PRIORITIES, { today: early, from: early, current: CURRENT });
		expect(p.plan.startsOn).toBe(CURRENT.startsOn);
		expect(p.decisions[0]!.evidence.from).toBe(SCENARIO_START);
	});

	it('is refused with too_many_blocks past the plan budget', () => {
		const week = CURRENT.blocks[0]!.weeks[0]!;
		const blocks = Array.from({ length: PLAN_BUDGET.blocks }, (_, i): BlockPlan => {
			const startsOn = addDays(SCENARIO_START, 7 * i);
			const w: WeekPlan = { ...week, startsOn, endsOn: addDays(startsOn, 6), sessions: [] };
			return { ...CURRENT.blocks[0]!, startsOn, endsOn: w.endsOn, weeks: [w] };
		});
		const long = {
			...CURRENT,
			blocks: [...blocks, { ...CURRENT.blocks.at(-1)!, startsOn: m7Day(11, 0) }]
		};
		const at = m7Day(11, 0);
		expect(refusal(swap, PRIORITIES, { today: at, from: at, current: long })).toBe(
			'too_many_blocks'
		);
	});
});

describe('regenerate: a chosen block', () => {
	const runner = M7_SCENARIOS.runnerLifter();
	const current = generate(runner);
	const after = m7Day(19, 0);

	it('plans a hypertrophy block after the marathon, its event blocks untouched', () => {
		const block: ReplanDirective = { kind: 'block', phase: 'hypertrophy', weeks: 6 };
		const p = replan(runner, block, { today: after, from: after, current }).plan;
		const at = p.blocks.findIndex((b) => b.startsOn === after);
		expect(p.blocks[at]).toMatchObject({ phase: 'hypertrophy', endsOn: addDays(after, 41) });
		expect(p.blocks.slice(0, at)).toEqual(current.blocks.filter((b) => b.endsOn < after));
	});

	it('plans a maintenance block in detail inside the planned block', () => {
		const from = m7Day(3, 0);
		const block: ReplanDirective = { kind: 'block', phase: 'maintenance', weeks: 4 };
		const p = replan(HYBRID, block, { today: from, from, current: CURRENT }).plan;
		expect(p.blocks[1]).toMatchObject({ phase: 'maintenance', outline: false, startsOn: from });
		expect(p.blocks[1]!.weeks).toHaveLength(4);
		expect(p.blocks[1]!.weeks.every((w) => w.sessions.length > 0)).toBe(true);
	});

	it('from the program’s start compares the new block with the one it replaces, as planned', () => {
		const block: ReplanDirective = { kind: 'block', phase: 'maintenance', weeks: 4 };
		const o = { today: SCENARIO_START, from: SCENARIO_START, current: CURRENT };
		const sets = replan(HYBRID, block, o).decisions.filter(
			(d) => d.ruleKey === 'next_block.hard_sets'
		);
		expect(sets.filter((d) => String(d.evidence.change).startsWith('0 to '))).toEqual([]);
	});

	it('refuses a hypertrophy block 6 weeks before a primary meet (S12)', () => {
		const meet = M7_SCENARIOS.meetPrep();
		const from = m7Day(4, 0);
		const block: ReplanDirective = { kind: 'block', phase: 'hypertrophy', weeks: 4 };
		const s = skeleton(inputOf(meet), block, { today: from, from, current: generate(meet) });
		expect(s).toMatchObject({ refusal: 'conflicts_with_event' });
		expect('why' in s && s.why).toMatch(/Powerlifting meet on .* leads then: Meet prep/);
	});
});

describe('regenerate: when timefit drops a kept accessory', () => {
	const from = m7Day(3, 0);
	const block: ReplanDirective = { kind: 'block', phase: 'hypertrophy', weeks: 4 };
	it.each([
		['dumbbellsOnly', PRIORITIES],
		['dumbbellsOnly', block],
		['injuredShoulder', PRIORITIES],
		['injuredShoulder', block]
	] as const)('%s, %o: each exercise_kept names its exercise where it sits', (key, directive) => {
		const profile = SCENARIOS[key]();
		const input = inputOf(profile);
		const r = replan(profile, directive, { today: from, from, current: generate(profile) });
		const kept = r.decisions.filter((d) => d.kind === 'exercise_kept');
		expect(kept.length).toBeGreaterThan(0);
		for (const d of kept) {
			const [, b, w, s, e] = /blocks\.(\d+)\.weeks\.(\d+)\.sessions\.(\d+)\.exercises\.(\d+)/
				.exec(d.refs[0]!)!
				.map(Number);
			const session = r.plan.blocks[b!]!.weeks[w!]!.sessions[s!] as StrengthSessionPlan;
			const at = exerciseRefKey(session.exercises[e!]!.exercise);
			expect(exerciseOf(input, at as never)!.name).toBe(d.evidence.exercise);
		}
	});
});

describe('a taper or a deload is refused for now', () => {
	const from = m7Day(3, 0);
	const taper: ReplanDirective = {
		kind: 'taper',
		goalRef: goalId(HYBRID, /marathon/i),
		form: 'full'
	};
	const deload: ReplanDirective = { kind: 'deload', week: from, trigger: 'owner', reasons: [] };

	it.each([
		['taper', taper],
		['deload', deload]
	] as const)(
		'refuses a %s with not_applicable and says nothing was changed',
		(kind, directive) => {
			const s = skeleton(inputOf(HYBRID), directive, { today: from, from, current: CURRENT });
			expect(s).toMatchObject({ refusal: 'not_applicable' });
			expect('why' in s && s.why).toMatch(
				new RegExp(`Re-planning a ${kind} is not available yet; nothing was changed\\.$`)
			);
		}
	);
});

describe('the hashes', () => {
	const swap = M7_SCENARIOS.hybridSwap();
	const from = m7Day(3, 0);
	const o = { today: from, from, current: CURRENT };
	const fingerprintOf = (profile: TrainingProfile, extra: Partial<Options> = {}) => {
		const s = skeleton(inputOf(profile), PRIORITIES, { ...o, ...extra });
		return 'refusal' in s ? null : s.fingerprint;
	};

	it('fingerprints the profile, the directive, the base version and from, deterministically', () => {
		expect(fingerprintOf(swap)).toMatch(/^[0-9a-f]{16}$/);
		expect(fingerprintOf(swap)).toBe(fingerprintOf(M7_SCENARIOS.hybridSwap()));
		expect(fingerprintOf(HYBRID)).not.toBe(fingerprintOf(swap));
		expect(fingerprintOf(swap, { baseVersionNumber: 2 })).not.toBe(fingerprintOf(swap));
		expect(replan(swap, PRIORITIES, o)).toEqual(replan(swap, PRIORITIES, o));
	});

	it('leaves the actuals out of the fingerprint and the loads out of the shape digest', () => {
		const input = inputOf(swap);
		const s = skeleton(input, PRIORITIES, o);
		if ('refusal' in s) throw new Error(s.why);
		const stronger: ProgrammingInput = {
			...input,
			baselines: Object.fromEntries(
				Object.entries(input.baselines).map(([lift, b]) => [lift, b && { ...b, kg: b.kg + 20 }])
			) as ProgrammingInput['baselines']
		};
		const [a, b] = [generateReplan(input, s, RESULTS), generateReplan(stronger, s, RESULTS)];
		expect(sessionsOf(a.plan)).not.toEqual(sessionsOf(b.plan));
		expect(b.fingerprint).toBe(a.fingerprint);
		expect(b.shapeDigest).toBe(a.shapeDigest);
	});
});

describe('the replan rules', () => {
	it('cite only this area’s keys, each registered', { timeout: 60_000 }, () => {
		const cited = [
			...staticRuleKeys(['src/lib/domain/programming/periodisation/replan.ts'])
		].sort();
		expect(cited).toEqual(['replan.in_place', 'replan.regenerate', 'replan.splice']);
		for (const key of cited) expect(RULE_BY_ID.get(key)?.area).toBe('replan');
	});
});
