/**
 * replan-domain: each directive becomes one deterministic change by its mechanism (regenerate,
 * splice, in place), never touching the past or an event date, and never changing a week it does
 * not mean to (weekShapes); every case it cannot plan is refused with its reason.
 */
import { describe, expect, it } from 'vitest';
import { addDays } from '../../calendar';
import type { IsoDate } from '../../calendar';
import { CATALOGUE } from '../../exercises/index';
import type { TrainingProfile } from '../../profile/types';
import type { ReplanDirective } from '../../training/replan';
import { exerciseRefKey } from '../../training/metrics';
import type {
	BlockPlan,
	ProgramPlan,
	SessionPlan,
	StrengthSessionPlan,
	WeekPlan
} from '../../training/types';
import { generateProgram } from '../generate';
import { buildProgrammingInput } from '../input';
import type { ProgrammingInput } from '../input';
import { weekShapes } from '../replan/changes';
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
const weekOn = (plan: ProgramPlan, monday: IsoDate) =>
	weeksOf(plan).find((w) => w.startsOn === monday)!;
/** A session without its values (an eased run's type is one): what a deload or taper keeps. */
const identity = (s: SessionPlan) => ({
	date: s.date,
	orderInDay: s.orderInDay,
	kind: s.kind,
	exercises: s.kind === 'strength' ? s.exercises.map((e) => exerciseRefKey(e.exercise)) : null
});
const later = (shapes: Record<IsoDate, string>, after: IsoDate) =>
	Object.fromEntries(Object.entries(shapes).filter(([monday]) => monday > after));
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
const paused = (profile: TrainingProfile, title: RegExp): TrainingProfile => ({
	...profile,
	goals: profile.goals.map((g) => (title.test(g.title) ? { ...g, status: 'paused' as const } : g))
});
const withEvent = (profile: TrainingProfile, title: RegExp, date: IsoDate): TrainingProfile => ({
	...profile,
	goals: profile.goals.map((g) => (title.test(g.title) ? { ...g, eventDate: date } : g))
});

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

describe('in place: a deload', () => {
	const week = m7Day(2, 0);
	const deload = (trigger: 'owner' | 'reactive' = 'owner', at = week): ReplanDirective => ({
		kind: 'deload',
		week: at,
		trigger,
		reasons: ['Fatigue is high']
	});
	const run = (today: IsoDate, started: ReplanOptions['started'] = []) =>
		replan(HYBRID, deload(), { today, from: week, current: CURRENT, started });

	it('made on Monday with nothing logged, changes only the week’s sessions, and only their values', () => {
		const r = run(week);
		const before = weekOn(CURRENT, week);
		const after = weekOn(r.plan, week);
		expect(after.kind).toBe('deload');
		expect(after.targets.rpeCap).toBeLessThan(before.targets.rpeCap);
		expect(after.sessions.map(identity)).toEqual(before.sessions.map(identity));
		after.sessions.forEach((s, i) => expect(s).not.toEqual(before.sessions[i]));
		const others = (p: ProgramPlan) => weeksOf(p).filter((w) => w.startsOn !== week);
		expect(others(r.plan)).toEqual(others(CURRENT));
		expect(r.plan.blocks.slice(1)).toEqual(CURRENT.blocks.slice(1));
		expect(r.weeks).toEqual([after]);
		expect(r.decisions[0]).toMatchObject({ ruleKey: 'replan.in_place', refs: ['blocks.0'] });
	});

	it('made on Thursday, changes only Thursday to Sunday, and never a session with a workout', () => {
		const thursday = addDays(week, 3);
		const before = weekOn(CURRENT, week).sessions;
		const done = before.find((s) => s.date >= addDays(week, 4))!;
		const after = weekOn(run(thursday, [done]).plan, week).sessions;
		after.forEach((s, i) => {
			if (s.date < thursday || s === after[before.indexOf(done)]) expect(s).toEqual(before[i]);
			else expect(s).not.toEqual(before[i]);
		});
		expect(after.some((s) => s.date >= thursday && s.date !== done.date)).toBe(true);
	});

	it('leaves every later week’s shape as it was', () => {
		const r = run(week);
		expect(later(weekShapes(r.plan, week), week)).toEqual(later(weekShapes(CURRENT, week), week));
	});

	it('is refused with nothing_ahead after its week, and held for a deload in the two weeks after', () => {
		expect(
			refusal(HYBRID, deload('reactive'), { today: m7Day(3, 0), from: week, current: CURRENT })
		).toBe('nothing_ahead');
		const held = skeleton(inputOf(HYBRID), deload('owner', m7Day(3, 0)), {
			today: m7Day(3, 0),
			from: m7Day(3, 0),
			current: CURRENT
		});
		expect(held).toMatchObject({ refusal: 'not_applicable' });
		expect('why' in held && held.why).toMatch(/A deload week starts on 2026-12-07/);
		expect(
			refusal(HYBRID, deload('owner', m7Day(4, 0)), { today: week, from: week, current: CURRENT })
		).toBe('not_applicable');
	});
	it('is held for an outline taper block starting in the two weeks after (no weeks yet)', () => {
		const [detailed, next, ...rest] = CURRENT.blocks;
		const tapering: ProgramPlan = {
			...CURRENT,
			blocks: [
				{
					...detailed!,
					weeks: detailed!.weeks.map((w) =>
						w.kind === 'deload' ? { ...w, kind: 'accumulation' as const } : w
					)
				},
				{ ...next!, phase: 'marathon_taper', outline: true, weeks: [] },
				...rest
			]
		};
		const at = m7Day(4, 0);
		const held = skeleton(inputOf(HYBRID), deload('reactive', at), {
			today: at,
			from: at,
			current: tapering
		});
		expect(held).toMatchObject({ refusal: 'not_applicable' });
		expect('why' in held && held.why).toMatch(/A marathon taper block starts on 2026-12-14/);
	});

	it('is not held for an event trained through in the two weeks after', () => {
		// The marathon, inside its lead window, leads the 10K's week: the 10K gets no light week.
		const leading = withEvent(HYBRID, /marathon/i, '2027-03-14');
		const ten: TrainingProfile = {
			...leading,
			goals: [
				...leading.goals,
				{
					...HYBRID.goals.find((g) => g.kind === 'event')!,
					id: '00000000-0000-4000-8007-000000000998',
					title: '10K race',
					eventType: '10K race',
					eventDate: m7Day(4, 5),
					priority: 4
				}
			]
		};
		const r = replan(ten, deload(), { today: week, from: week, current: CURRENT });
		expect(weekOn(r.plan, week).kind).toBe('deload');
	});
});

describe('splice: a taper', () => {
	const s5 = M7_SCENARIOS.marathonTaper();
	const marathon = goalId(s5, /marathon/i);
	const raceOn = s5.goals.find((g) => g.id === marathon)!.eventDate!;
	const before5 = generate(paused(s5, /marathon/i));
	const start = m7Day(1, 0);
	const full = (goalRef: string): ReplanDirective => ({ kind: 'taper', goalRef, form: 'full' });
	const r5 = replan(s5, full(marathon), { today: start, from: start, current: before5 });

	it('S5: tapers on the marathon’s dates and keeps strength at maintenance', () => {
		const taper = taperWeeks('marathon', 'primary', raceOn);
		expect(r5.plan.blocks[0]).toMatchObject({
			phase: 'marathon_taper',
			startsOn: taper.weeks[0]!.startsOn,
			endsOn: raceOn,
			goalRefs: [marathon]
		});
		expect(r5.weeks.map((w) => w.kind)).toEqual(['taper', 'taper', 'taper']);
		for (const w of r5.weeks) {
			const strength = w.sessions.filter((s) => s.kind === 'strength');
			expect(strength).toHaveLength(1);
			expect(raceOn > addDays(strength[0]!.date, 3)).toBe(true);
		}
		expect(r5.decisions[0]).toMatchObject({ ruleKey: 'replan.splice' });
	});

	it('keeps the days and exercises of a meet taper, with fewer sets', () => {
		const meet = withEvent(M7_SCENARIOS.meetPrep(), /meet/i, m7Day(4, 5));
		const id = goalId(meet, /meet/i);
		const current = generate(paused(meet, /meet/i));
		const r = replan(meet, full(id), { today: start, from: start, current });
		const [week] = r.weeks;
		const was = weekOn(current, week!.startsOn).sessions;
		expect(week!.sessions.map(identity)).toEqual(was.map(identity));
		const sets = (ss: SessionPlan[]) =>
			ss
				.flatMap((s) => (s.kind === 'strength' ? s.exercises.flatMap((e) => e.sets) : []))
				.reduce((n, line) => n + line.sets, 0);
		expect(sets(week!.sessions)).toBeLessThan(sets(was));
		const event = m7Day(4, 6);
		expect(later(weekShapes(r.plan, start), event)).toEqual(
			later(weekShapes(current, start), event)
		);
	});

	it('records the taper it splices, so the same taper on its own output is refused', () => {
		expect(r5.decisions).toContainEqual(
			expect.objectContaining({
				kind: 'taper_planned',
				ruleKey: 'replan.splice',
				refs: ['blocks.0']
			})
		);
		const again = { today: start, from: start, current: r5.plan };
		expect(refusal(s5, full(marathon), again)).toBe('not_applicable');
	});

	it('refuses a full taper already planned by an earlier version, found by its block', () => {
		// A stored version records only its own decisions: a later version may not carry taper_planned.
		const later = { today: start, from: start, current: { ...r5.plan, decisions: [] } };
		expect(refusal(s5, full(marathon), later)).toBe('not_applicable');
		const seasonal = generate(s5);
		const own = { today: start, from: start, current: { ...seasonal, decisions: [] } };
		expect(refusal(s5, full(marathon), own)).toBe('not_applicable');
	});

	it('refuses a taper for an event after the plan ends', () => {
		const runner = M7_SCENARIOS.runnerLifter();
		const current = generate(paused(runner, /marathon/i));
		const goalRef = goalId(runner, /marathon/i);
		for (const form of ['full', 'mini'] as const)
			expect(
				refusal(runner, { kind: 'taper', goalRef, form }, { today: start, from: start, current })
			).toBe('not_applicable');
	});

	it('keeps the shape of every week after the event', () => {
		expect(later(weekShapes(r5.plan, start), raceOn)).toEqual(
			later(weekShapes(before5, start), raceOn)
		);
		expect(r5.plan.blocks.at(-1)).toEqual(before5.blocks.at(-1));
	});

	const race = '00000000-0000-4000-8007-000000000999';
	const meet = M7_SCENARIOS.meetPrep();
	/** meetPrep with a secondary 10K: the season gives it a mini-taper. */
	const ten: TrainingProfile = {
		...meet,
		goals: [
			...meet.goals.map((g) => (g.priority === 2 ? { ...g, priority: 3 } : g)),
			{
				...meet.goals[0]!,
				id: race,
				title: '10K race',
				disciplines: ['running'],
				eventType: '10K race',
				eventDate: m7Day(7, 5),
				priority: 2
			}
		]
	};

	it('plans a mini-taper upgraded to full, and refuses a taper already planned', () => {
		const current = generate(ten);
		expect(
			current.decisions.find((d) => d.kind === 'taper_planned' && d.evidence.length === '3 days')
		).toBeDefined();
		const p = replan(ten, full(race), { today: start, from: start, current }).plan;
		expect(p.blocks.find((b) => b.goalRefs[0] === race)).toMatchObject({
			phase: 'taper',
			startsOn: m7Day(7, 0)
		});
		const opts = { today: start, from: start, current };
		expect(refusal(ten, { kind: 'taper', goalRef: race, form: 'mini' }, opts)).toBe(
			'not_applicable'
		);
		expect(refusal(ten, full(goalId(ten, /meet/i)), opts)).toBe('not_applicable');
	});

	it('never applies a re-plan’s mini-taper twice: not after a later re-plan, nor under a full one', () => {
		// runnerLifter with a secondary 10K in its detailed block, and no light week near its start.
		const runner = M7_SCENARIOS.runnerLifter();
		const soon: TrainingProfile = {
			...runner,
			goals: [
				...runner.goals.map((g) => (g.priority === 2 ? { ...g, priority: 3 } : g)),
				{ ...ten.goals.at(-1)!, eventDate: m7Day(5, 5) }
			]
		};
		const mini: ReplanDirective = { kind: 'taper', goalRef: race, form: 'mini' };
		// A later version, without the season's own taper_planned: the mini-taper applies.
		const v1 = { ...generate(soon), decisions: [] };
		const v2 = replan(soon, mini, { today: start, from: start, current: v1 }).plan;
		const deload: ReplanDirective = { kind: 'deload', week: start, trigger: 'owner', reasons: [] };
		const v3 = replan(soon, deload, { today: start, from: start, current: v2 }).plan;
		for (const current of [v2, v3]) {
			const opts = { today: start, from: start, current };
			expect(refusal(soon, mini, opts)).toBe('not_applicable');
			expect(refusal(soon, full(race), opts)).toBe('not_applicable');
		}
	});

	it('is refused as too_close from the taper’s second week, never a shortened taper', () => {
		const second = taperWeeks('marathon', 'primary', raceOn).weeks[1]!.startsOn;
		const o = { today: second, from: second, current: before5 };
		expect(refusal(s5, full(marathon), o)).toBe('too_close');
	});

	it('is refused as too_close once its taper should have started', () => {
		const tuesday = withEvent(s5, /marathon/i, m7Day(3, 1));
		const at = m7Day(3, 0);
		expect(refusal(tuesday, full(marathon), { today: at, from: at, current: before5 })).toBe(
			'too_close'
		);
	});
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
