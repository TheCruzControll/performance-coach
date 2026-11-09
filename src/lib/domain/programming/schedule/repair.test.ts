/**
 * schedule/repair.ts: the week scheduler, on the PRD §5 weeks (periodisation/weeks.ts) in the week
 * of Monday 9 November 2026, and on multiGoal's generated week.
 */
import { describe, expect, it } from 'vitest';
import { addDays } from '../../calendar';
import { CATALOGUE } from '../../exercises/index';
import type { Discipline } from '../../profile/catalog';
import { moveSessionSchema } from '../../training/edits';
import { validate } from '../../validation';
import { demandOf } from '../interference';
import { buildProgrammingInput, generateProgram } from '../index';
import { fromLogged } from '../load/from-facts';
import { HISTORIES } from '../periodisation/histories';
import { M7_SCENARIOS } from '../periodisation/scenarios';
import { PRD_WEEKS, weekDay } from '../periodisation/weeks';
import type { PrdWeek } from '../periodisation/weeks';
import { effectivePriorities } from '../priority/weights';
import type { GoalPriority } from '../priority/weights';
import { seededRandom } from '../random';
import { DOUBLES } from '../rules/days';
import { RANK_WEIGHTS } from '../rules/priority';
import { RULE_BY_ID } from '../rules/registry/index';
import { BOUNDS, EASE } from '../rules/schedule';
import { SCENARIO_START } from '../scenarios';
import type { EvaluatedSession } from '../evaluate/week';
import { repairWeek } from './repair';
import type { RepairContext } from './repair';

// ---- Sessions and contexts ------------------------------------------------------------------

type Over = Partial<EvaluatedSession>;
const at = (session: EvaluatedSession, day: number, over: Over = {}) =>
	({ ...session, date: weekDay(day), ...over }) as EvaluatedSession;
/** Heavy squats, hard: back squat 4 × 5 at RPE 8. */
const lowerA = (day: number, over?: Over) => at(PRD_WEEKS.squat_before_sparring()[0]!, day, over);
/** Hard sparring: a commitment, in the evening. */
const sparring = (day: number, over?: Over) => at(PRD_WEEKS.squat_before_sparring()[1]!, day, over);
/** A hard Muay Thai class: a commitment, in the evening. */
const thaiClass = (day: number) =>
	sparring(day, {
		title: 'Muay Thai class',
		lineage: `class-${day}`,
		details: { kind: 'class' }
	} as Over);
const easyRun = (day: number, over?: Over) => at(PRD_WEEKS.squat_before_sparring()[2]!, day, over);
/** 11 hard lower-body sets at RPE 7: heavy by volume, so easing leaves it heavy. */
const legVolume = (day: number) => at(PRD_WEEKS.legs_before_long_run()[1]!, day);
const longRun = (day: number) => at(PRD_WEEKS.legs_before_long_run()[2]!, day);

const WEEK = Array.from({ length: 7 }, (_, n) => weekDay(n));
const CTX: RepairContext = { open: WEEK, preferredTimes: ['morning'] };

const goal = (title: string, disciplines: Discipline[], rank: number): GoalPriority => ({
	goalId: title.toLowerCase().replaceAll(' ', '-'),
	title,
	disciplines,
	priority: rank + 1,
	rank,
	weight: RANK_WEIGHTS[rank]!,
	mode: rank === 0 ? 'primary' : 'secondary',
	why: `${title} is in place ${rank + 1}.`,
	eventKind: null,
	eventDate: null,
	weeksToEvent: null,
	inWindow: false,
	rule: 'priority.rank_weights'
});

const uuid = (n: number) => `00000000-0000-4000-8021-${String(n).padStart(12, '0')}`;
/** The week with stored lineages (uuids), as the owner's own week has them. */
const stored = (sessions: EvaluatedSession[]) =>
	sessions.map((s, n) => ({ ...s, lineage: uuid(n + 1) }));

const avoids = (r: ReturnType<typeof repairWeek>) =>
	r.after.evaluation.findings.filter((f) => f.severity === 'avoid');
const dayOf = (r: ReturnType<typeof repairWeek>, title: string) =>
	r.sessions.find((s) => s.title === title)?.date;

// ---- The PRD §5 conflicts -------------------------------------------------------------------

describe('repairWeek: the PRD §5 conflicts', () => {
	it('legs_before_long_run moves the generated legs day off Friday, with schedule_repaired naming the rule', () => {
		const r = repairWeek(PRD_WEEKS.legs_before_long_run(), CTX);
		expect(r.actions).toHaveLength(1);
		const [move] = r.actions;
		expect(move).toMatchObject({
			kind: 'move',
			session: { lineage: 'legs-volume', title: 'Legs volume' },
			from: { date: weekDay(4), timeOfDay: null },
			to: { date: weekDay(3), timeOfDay: null },
			rule: 'placement.heavy_lower_before_hard',
			decision: {
				kind: 'schedule_repaired',
				ruleKey: 'placement.heavy_lower_before_hard',
				facts: { session: 'Legs volume', from: 'Friday', to: 'Thursday' }
			}
		});
		expect(move!.why).toBe(
			`Heavy lower body the day before a long run: Legs volume on Friday, then Long run on Saturday, so Legs volume moves from Friday to Thursday. ${move!.decision.facts.reason}`
		);
		expect(RULE_BY_ID.has(move!.decision.ruleKey)).toBe(true);
		expect(dayOf(r, 'Long run')).toBe(weekDay(5));
		expect(r.after.evaluation.findings).toEqual([]);
		expect(r.kept).toEqual([]);
	});

	it('a generated squat day before sparring moves to a free day, never beside the sparring', () => {
		const r = repairWeek(PRD_WEEKS.squat_before_sparring(), {
			...CTX,
			preferredTimes: ['morning', 'evening']
		});
		// Wednesday, the nearest free day, sits after the sparring; Friday keeps a day either side.
		expect(r.actions.map((a) => [a.kind, a.session.title, a.rule, a.to?.date])).toEqual([
			['move', 'Lower A', 'placement.heavy_lower_before_hard', weekDay(4)]
		]);
		expect(r.actions[0]!.why).toMatch(
			/^Heavy lower body the day before hard Muay Thai: Lower A on Monday, then Muay Thai sparring on Tuesday, so Lower A moves from Monday to Friday\./
		);
		expect(dayOf(r, 'Muay Thai sparring')).toBe(weekDay(1));
		expect(avoids(r)).toEqual([]);
	});

	it('with only Monday and Friday free around Tuesday and Thursday classes and a Saturday long run, the higher-priority goal keeps its day', () => {
		const week = [lowerA(0), thaiClass(1), thaiClass(3), longRun(5)];
		const priorities = [
			goal('Get stronger', ['strength'], 0),
			goal('Marathon', ['distance_running'], 1),
			goal('Muay Thai', ['muay_thai'], 2)
		];
		const r = repairWeek(week, { ...CTX, open: [weekDay(0), weekDay(4)], priorities });
		// Friday would put the squats before the marathon's long run, which ranks above Muay Thai,
		// and neither the squats nor the classes may give way to a lower-ranked goal.
		expect(r.actions).toEqual([]);
		expect(dayOf(r, 'Lower A')).toBe(weekDay(0));
		expect(r.kept).toHaveLength(1);
		const [kept] = r.kept;
		expect(kept!.finding).toMatchObject({
			rule: 'placement.heavy_lower_before_hard',
			resolution: { kind: 'priority_kept' }
		});
		expect(kept!.tradeoff).toBe(
			'Heavy lower body the day before hard Muay Thai: kept, because Get stronger ranks ahead of Muay Thai on this date, so Muay Thai gives way.'
		);
		expect(kept!.decision).toEqual({
			kind: 'priority_tradeoff',
			ruleKey: 'schedule.priority_kept',
			facts: { kept: 'Get stronger', given: 'Muay Thai', reason: kept!.tradeoff }
		});
		expect(RULE_BY_ID.get('schedule.priority_kept')?.area).toBe('schedule');
	});

	it('moves a hard session off a system the logged days before overloaded, and remodels its load', () => {
		const camp = fromLogged(HISTORIES.hardCampWeek(1));
		const load = { from: weekDay(0), logged: camp };
		const ctx = { ...CTX, load, today: weekDay(1) };
		const r = repairWeek([lowerA(1)], ctx);
		expect(r.before.evaluation.findings.map((f) => f.rule)).toEqual([
			'concurrent.residual_fatigue_before_hard'
		]);
		expect(r.actions.map((a) => [a.kind, a.rule])).toEqual([
			['move', 'concurrent.residual_fatigue_before_hard']
		]);
		expect(dayOf(r, 'Lower A')! > weekDay(1)).toBe(true);
		expect(r.after.evaluation.findings).toEqual([]);
	});
});

// ---- The owner's own week -------------------------------------------------------------------

describe('repairWeek: the owner’s moves', () => {
	const owner = () => stored(PRD_WEEKS.owner_moved_conflict());

	it('owner_moved_conflict with keepOwnerMoves true reports the finding as kept, with the owner’s reason', () => {
		const r = repairWeek(owner(), CTX);
		expect(r.actions).toEqual([]);
		expect(r.ops).toEqual([]);
		expect(r.kept.map((k) => [k.finding.rule, k.finding.resolution?.kind, k.tradeoff])).toEqual([
			['placement.heavy_lower_before_hard', 'owner_moved', 'You moved Lower A here from Monday.'],
			['placement.hard_days_apart', 'owner_moved', 'You moved Lower A here from Monday.']
		]);
	});

	it('with false, it moves the owner’s session and returns one moveSession op that parses', () => {
		const week = owner();
		const r = repairWeek(week, { ...CTX, keepOwnerMoves: false });
		const lower = week.find((s) => s.title === 'Lower A')!;
		expect(r.ops).toEqual([{ sessionLineage: lower.lineage, toDate: weekDay(2) }]);
		const parsed = validate(moveSessionSchema, r.ops[0]);
		expect(parsed.ok).toBe(true);
		expect(r.actions.map((a) => [a.kind, a.session.lineage, a.to?.date])).toEqual([
			['move', lower.lineage, weekDay(2)]
		]);
		expect(avoids(r)).toEqual([]);
	});

	it('gives no ops for a time-of-day change, which moveSession refuses as a move to its own day', () => {
		// A hard Upper A on Thursday afternoon, three hours before the hard class.
		const week = stored([
			lowerA(0),
			easyRun(1),
			thaiClass(3),
			lowerA(3, { title: 'Upper A', timeOfDay: 'afternoon', exercises: [] } as Over)
		]);
		const today = weekDay(2);
		const r = repairWeek(week, {
			...CTX,
			open: [weekDay(3)],
			preferredTimes: ['morning', 'evening'],
			week: { kind: 'build' },
			keepOwnerMoves: false,
			today
		});
		expect(r.actions.map((a) => [a.kind, a.rule, a.from.date, a.to?.date])).toEqual([
			['time', 'concurrent.same_day_separation', weekDay(3), weekDay(3)]
		]);
		// edits.ts destinationRefusal: 'It is already on that day' for a toDate equal to its date.
		expect(r.ops).toEqual([]);
	});

	it('gives no ops when an ease is needed, which a move cannot express', () => {
		// Two weeks: the first has no other day for its squats, the second moves its legs day.
		const week = stored([lowerA(0), sparring(1), legVolume(11), longRun(12)]);
		const r = repairWeek(week, { ...CTX, open: [weekDay(0), weekDay(10), weekDay(11)] });
		expect(r.actions.map((a) => [a.kind, a.session.title])).toEqual([
			['ease', 'Lower A'],
			['move', 'Legs volume']
		]);
		expect(r.ops).toEqual([]);
	});
});

// ---- Invariants -----------------------------------------------------------------------------

const WEEKS = Object.keys(PRD_WEEKS) as PrdWeek[];
const CONTEXTS: Record<string, RepairContext> = {
	plain: CTX,
	doubles: { ...CTX, preferredTimes: ['morning', 'evening'] },
	ranked: {
		...CTX,
		level: 'novice',
		week: { kind: 'build' },
		priorities: [goal('Fight', ['muay_thai'], 0), goal('Marathon', ['running'], 1)]
	},
	owner: { ...CTX, keepOwnerMoves: false, today: weekDay(1), open: WEEK.slice(0, 6) }
};
const CASES = WEEKS.flatMap((week) =>
	Object.entries(CONTEXTS).map(([name, ctx]) => [week, name, ctx] as const)
);

describe('repairWeek: invariants', () => {
	it.each(CASES)('%s (%s): commitments and past sessions never move', (week, _, ctx) => {
		const sessions = PRD_WEEKS[week]();
		const r = repairWeek(sessions, ctx);
		const fixed = sessions.filter(
			(s) => s.source === 'commitment' || (ctx.today !== undefined && s.date < ctx.today)
		);
		expect(r.sessions).toEqual(expect.arrayContaining(fixed));
	});

	it.each(CASES)('%s (%s): the day rule and doubles hold', (week, _, ctx) => {
		const r = repairWeek(PRD_WEEKS[week](), ctx);
		const times = new Set(ctx.preferredTimes.filter((t) => t !== 'varies'));
		for (const day of Map.groupBy(r.sessions, (s) => s.date).values()) {
			const generated = day.filter((s) => s.source !== 'commitment');
			expect(generated.length).toBeLessThanOrEqual(1);
			if (generated.length === 0 || generated.length === day.length) continue;
			expect(day).toHaveLength(2);
			expect(times.size).toBeGreaterThanOrEqual(DOUBLES.distinctTimes);
			expect(generated[0]!.estMinutes).toBeLessThanOrEqual(DOUBLES.maxSessionMinutes);
			expect(generated[0]!.timeOfDay).not.toBe(day.find((s) => s !== generated[0])!.timeOfDay);
		}
	});

	it.each(CASES)('%s (%s): the cost never rises, and repair is idempotent', (week, _, ctx) => {
		const r = repairWeek(PRD_WEEKS[week](), ctx);
		expect(r.after.cost).toBeLessThanOrEqual(r.before.cost);
		const again = repairWeek(r.sessions, ctx);
		expect(again.actions).toEqual([]);
		expect(again.sessions).toEqual(r.sessions);
	});

	it('is idempotent when a change brings a new finding: it is tried in the same pass', () => {
		const week = [
			longRun(0),
			at(PRD_WEEKS.commitments_only_clash()[0]!, 1),
			sparring(2),
			at(PRD_WEEKS.hard_days_back_to_back()[1]!, 3),
			at(PRD_WEEKS.intervals_after_demanding()[1]!, 4)
		];
		const ctx: RepairContext = {
			open: WEEK,
			preferredTimes: ['morning', 'evening'],
			level: 'intermediate',
			week: { kind: 'build' },
			priorities: [
				goal('Get stronger', ['strength'], 0),
				goal('Marathon', ['running'], 1),
				goal('Muay Thai', ['muay_thai'], 2)
			]
		};
		const r = repairWeek(week, ctx);
		expect(r.after.evaluation.findings).toEqual([]);
		const again = repairWeek(r.sessions, ctx);
		expect(again.actions).toEqual([]);
		expect(again.sessions).toEqual(r.sessions);
	});

	it('keeps the weekend long run on the weekend', () => {
		// Sunday's long run after the squats the owner moved to Saturday: Friday is free but a weekday.
		const moved = lowerA(5, { status: 'moved', movedFrom: weekDay(0) });
		const r = repairWeek([moved, longRun(6)], {
			...CTX,
			open: [weekDay(4), weekDay(5), weekDay(6)]
		});
		expect(r.actions).toEqual([]);
		expect(dayOf(r, 'Long run')).toBe(weekDay(6));
	});

	it('never puts two generated sessions on a day: it swaps them instead', () => {
		const week = [easyRun(3), legVolume(4), longRun(5)];
		const r = repairWeek(week, {
			open: [weekDay(3), weekDay(4), weekDay(5)],
			preferredTimes: ['morning', 'evening']
		});
		expect(r.actions.map((a) => [a.kind, a.session.title, a.to?.date])).toEqual([
			['swap', 'Legs volume', weekDay(3)],
			['swap', 'Easy run', weekDay(4)]
		]);
		expect(avoids(r)).toEqual([]);
	});

	it('doubles beside a commitment only at a free preferred time and for 90 minutes or less', () => {
		const ctx = { ...CTX, open: [weekDay(0), weekDay(1)], preferredTimes: ['morning', 'evening'] };
		const doubled = repairWeek([lowerA(0), sparring(1)], ctx as RepairContext);
		expect(doubled.actions.map((a) => [a.kind, a.to])).toEqual([
			['move', { date: weekDay(1), timeOfDay: 'morning' }]
		]);
		const long = repairWeek(
			[lowerA(0, { estMinutes: DOUBLES.maxSessionMinutes + 30 }), sparring(1)],
			ctx as RepairContext
		);
		expect(long.actions.map((a) => [a.kind, a.to?.date])).toEqual([['ease', weekDay(0)]]);
		const oneTime = repairWeek([lowerA(0), sparring(1)], {
			...ctx,
			preferredTimes: ['evening']
		} as RepairContext);
		expect(oneTime.actions.map((a) => a.kind)).toEqual(['ease']);
	});

	it('eases before it drops, and drops only a lower-priority session easing cannot fix', () => {
		const priorities = [goal('Fight', ['muay_thai'], 0), goal('Get stronger', ['strength'], 1)];
		const ctx = { ...CTX, open: [weekDay(0)], priorities };
		const eased = repairWeek([lowerA(0), sparring(1)], ctx);
		expect(eased.actions.map((a) => [a.kind, a.decision.kind])).toEqual([['ease', 'load_eased']]);
		const squats = eased.sessions.find((s) => s.title === 'Lower A')!;
		expect(squats.intensity).toBe(EASE.intensity);
		expect(demandOf(squats).heavyLower).toBe(false);
		expect(eased.actions[0]!.decision.facts).toMatchObject({ session: 'Lower A', rpe: EASE.rpe });
		expect(avoids(eased)).toEqual([]);

		// 11 hard sets at RPE 7 stay heavy when eased, so the lower-priority legs day gives way.
		const dropped = repairWeek([legVolume(0), sparring(1)], ctx);
		expect(dropped.actions.map((a) => [a.kind, a.decision.kind, a.decision.ruleKey])).toEqual([
			['drop', 'session_dropped', 'schedule.drop']
		]);
		expect(dropped.actions[0]!.to).toBeNull();
		expect(dropped.sessions.map((s) => s.title)).toEqual(['Muay Thai sparring']);
		expect(dropped.after.cost).toBeLessThan(dropped.before.cost);

		// Without priorities nothing ranks below the sparring, so the legs day is kept, explained.
		const kept = repairWeek([legVolume(0), sparring(1)], { ...ctx, priorities: undefined });
		expect(kept.actions).toEqual([]);
		expect(kept.kept.map((k) => k.tradeoff)).toEqual([
			'The week has no free day to move Legs volume to.'
		]);
		// With a free day it cannot use (the long run’s eve), the trade-off says what was tried.
		const tried = repairWeek([legVolume(0), sparring(1), longRun(5)], {
			...ctx,
			open: [weekDay(0), weekDay(4)],
			priorities: undefined
		});
		expect(tried.actions).toEqual([]);
		expect(tried.kept.map((k) => k.tradeoff)).toEqual([
			'Heavy lower body the day before hard Muay Thai: kept, because no other day, time of day, easier version or lower-priority session to leave out fixes it without costing the week more.'
		]);
	});

	it('a clean week returns unchanged, with no decisions', () => {
		const week = PRD_WEEKS.clean_hybrid_week();
		const r = repairWeek(week, CTX);
		expect(r.after.evaluation.findings).toEqual([]);
		expect(r.actions).toEqual([]);
		expect(r.kept).toEqual([]);
		expect(r.ops).toEqual([]);
		expect(r.after).toEqual(r.before);
		expect(new Set(r.sessions)).toEqual(new Set(week));
		expect(r.evaluations).toBe(1);
	});
});

// ---- Determinism and bounds -----------------------------------------------------------------

describe('repairWeek: determinism and bounds', () => {
	const input = buildProgrammingInput(M7_SCENARIOS.multiGoal(), { catalogue: CATALOGUE });
	const plan = generateProgram(input, {
		startsOn: SCENARIO_START,
		firstPlannedDay: SCENARIO_START
	});
	const week = plan.blocks[0]!.weeks[1]!;
	// The generated week with its legs day and long run made a PRD §5 clash, so there is work to do.
	const sessions: EvaluatedSession[] = week.sessions.map((s) => ({ ...s }));
	const ctx: RepairContext = {
		open: Array.from({ length: 7 }, (_, n) => addDays(week.startsOn, n)),
		preferredTimes: input.preferredTimes,
		priorities: effectivePriorities(input, week.startsOn),
		level: 'intermediate',
		week: { kind: week.kind }
	};

	it(
		'gives byte-identical output for 200 seeded shuffles of multiGoal’s week',
		{ timeout: 60_000 },
		() => {
			const expected = JSON.stringify(repairWeek(sessions, ctx));
			const random = seededRandom('week-scheduler');
			for (let n = 0; n < 200; n++) {
				expect(JSON.stringify(repairWeek(random.shuffle(sessions), ctx))).toBe(expected);
			}
		}
	);

	it('stays within its bounds, never raises the cost, and repairs a week in under 100 ms', () => {
		const clash = [...sessions, lowerA(0, { date: week.startsOn })];
		const r = repairWeek(clash, ctx);
		expect(r.evaluations).toBeLessThanOrEqual(BOUNDS.evaluations);
		expect(r.after.cost).toBeLessThan(r.before.cost);
		expect(r.actions.length).toBeGreaterThan(0);
		// The fastest of 10 runs: the work itself, not a busy machine's other processes.
		const fastest = Math.min(
			...Array.from({ length: 10 }, () => {
				const t = performance.now();
				repairWeek(clash, ctx);
				return performance.now() - t;
			})
		);
		console.info(
			`repairWeek: multiGoal's week in ${fastest.toFixed(1)} ms, ${r.evaluations} evaluations`
		);
		expect(fastest).toBeLessThan(100);
	});
});
