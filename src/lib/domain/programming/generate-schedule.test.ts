/**
 * generator-schedule: the schedule stage repairs every planned week with the week scheduler, so
 * no avoid finding, judged with the load and the priorities, stands unless a higher-priority goal
 * keeps it with a priority_tradeoff decision; building weeks share their days; an eased session
 * is loaded again at its new target RPE and still fits its minutes; the journey's first week is
 * pinned.
 */
import { describe, expect, it } from 'vitest';
import { addDays, weekdayOf } from '../calendar';
import type { Weekday } from '../profile/catalog';
import { CATALOGUE } from '../exercises/index';
import type { TrainingProfile } from '../profile/types';
import { sessionLoadOf } from '../training/metrics';
import { programPlanSchema } from '../training/schemas';
import type {
	BlockPlan,
	PlannedExercisePlan,
	ProgramPlan,
	SessionPlan,
	StrengthSessionPlan,
	WeekPlan
} from '../training/types';
import { validate } from '../validation';
import { DecisionLog } from './decisions';
import { demandOf, catalogueTraits } from './interference';
import { firstDraft, generateProgram, STAGES } from './generate';
import { buildProgrammingInput } from './input';
import type { ProgrammingInput } from './input';
import { M7_SCENARIOS } from './periodisation/scenarios';
import type { M7ScenarioKey } from './periodisation/scenarios';
import { eventKindOf } from './priority/weights';
import { progressWeeks } from './progression';
import { RULE_BY_ID } from './rules/registry/index';
import { PLAN_BUDGET } from './rules/road';
import { EASE } from './rules/schedule';
import { openDates } from './running';
import { SCENARIO_START, SCENARIOS } from './scenarios';
import type { ScenarioKey } from './scenarios';
import { repairWeek } from './schedule/repair';
import type { Draft, Periodisation, StageContext } from './stage';
import { prepare } from './stages/prepare';
import { schedule } from './stages/schedule';
import { estimateMinutes } from './timefit';

const OPTIONS = { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START };
const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });

/** Every stage but schedule run on `profile`, the draft schedule receives, and its context. */
function beforeSchedule(profile: TrainingProfile) {
	const log = new DecisionLog();
	const prepared = prepare(inputOf(profile), OPTIONS, log);
	const context: StageContext = { input: prepared.input, options: OPTIONS, log };
	let draft = firstDraft(prepared);
	for (const stage of STAGES.filter((s) => s.name !== 'schedule')) {
		draft = stage.run(draft, context);
	}
	return { draft, context, periodisation: prepared.periodisation };
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

/**
 * Each planned week of `plan` judged as evaluateWeek judges it with the full context: the load of
 * the plan's week before and its own, the week's effective priorities, kind and targets, the
 * goals' events and the leader's level, with the day before the week and the next Monday's
 * commitments beside it, as placement judges a week. Judged through repairWeek, whose `before` is
 * that evaluation and whose actions say what a repair of the plan as stored would still change.
 */
function judgeWeeks(
	plan: ProgramPlan,
	input: ProgrammingInput,
	periodisation: Periodisation | null,
	days: readonly Weekday[]
) {
	const events = input.goals.flatMap((goal, i) => {
		const kind = eventKindOf(goal);
		return kind && goal.eventDate
			? [{ date: goal.eventDate, kind, title: goal.title, goalId: input.refs.goals[i]! }]
			: [];
	});
	const level = input.experience[input.disciplines[0]!];
	let before: SessionPlan[] = [];
	return plan.blocks.flatMap((block, b) =>
		block.weeks.map((week, w) => {
			const eve = addDays(week.startsOn, -1);
			const next =
				block.weeks[w + 1]?.sessions ??
				week.sessions.map((s) => ({ ...s, date: addDays(s.date, 7) }));
			const around = [
				...before.filter((s) => s.date === eve),
				...next.filter((s) => s.source === 'commitment' && s.date === addDays(week.endsOn, 1))
			].map((s, i) => ({ ...s, lineage: `around ${i}` }));
			const r = repairWeek(
				[...week.sessions.map((s, i) => ({ ...s, lineage: `${i}` })), ...around],
				{
					open: openDates(week, days, plan.firstPlannedDay),
					preferredTimes: input.preferredTimes,
					priorities: periodisation?.prioritiesByWeek.find((p) => p.startsOn === week.startsOn)
						?.priorities,
					week: { kind: week.kind, phase: block.phase, targets: week.targets },
					events,
					...(level && { level }),
					load: {
						from: addDays(week.startsOn, -7),
						planned: before.filter((s) => s.date !== eve),
						logged: []
					},
					completed: around.map((s) => s.lineage)
				}
			);
			before = week.sessions;
			return { b, w, week, r };
		})
	);
}

function generated(profile: TrainingProfile) {
	const { draft, context, periodisation } = beforeSchedule(profile);
	const plan = generateProgram(inputOf(profile), OPTIONS);
	const weeks = judgeWeeks(plan, context.input, periodisation, draft.demand!.budget.days);
	return { plan, weeks };
}

const tradeoffRefs = (plan: ProgramPlan) =>
	new Set(plan.decisions.filter((d) => d.kind === 'priority_tradeoff').flatMap((d) => d.refs));

/** The plan node a ref names, or undefined. */
function resolve(plan: ProgramPlan, ref: string): unknown {
	let node: unknown = plan;
	for (const part of ref.split('.')) {
		node = (node as Record<string, unknown> | undefined)?.[part];
	}
	return node;
}

describe('every M3 and M7 scenario', () => {
	it.each(ALL)(
		'%s: no avoid finding stands without a priority_tradeoff, and repair leaves every week as it is',
		(_, profile) => {
			const { plan, weeks } = generated(profile());
			const kept = tradeoffRefs(plan);
			for (const { b, w, week, r } of weeks) {
				// A clash between fixed commitments alone is the owner's, not the generator's.
				// So is one about the day before alone, judged with this week but planned with the last.
				const avoids = r.before.evaluation.findings.filter(
					(x) =>
						x.severity === 'avoid' &&
						x.resolution?.kind !== 'commitment_fixed' &&
						x.sessions.some((s) => !s.lineage!.startsWith('around'))
				);
				for (const f of avoids) {
					const refs = f.sessions.map((s) => `blocks.${b}.weeks.${w}.sessions.${s.lineage}`);
					expect(
						refs.some((ref) => kept.has(ref)),
						`${week.startsOn} ${f.message}`
					).toBe(true);
				}
				// Every week is final: the stage repaired it with this same judge.
				expect(r.actions, week.startsOn).toEqual([]);
			}
			expect(validate(programPlanSchema, plan)).toEqual({ ok: true, data: plan });
		}
	);

	it.each(ALL)('%s: every decision ref resolves, and the plan is the same every run', (_, p) => {
		const plan = generateProgram(inputOf(p()), OPTIONS);
		for (const d of plan.decisions) {
			for (const ref of d.refs) expect(resolve(plan, ref), `${d.kind} ${ref}`).toBeDefined();
			expect(RULE_BY_ID.has(d.ruleKey), d.ruleKey).toBe(true);
		}
		expect(JSON.stringify(generateProgram(inputOf(p()), OPTIONS))).toBe(JSON.stringify(plan));
	});
});

describe('journeyHybrid, the Playwright journey’s profile', () => {
	const { plan, weeks } = generated(M7_SCENARIOS.journeyHybrid());

	it('grades its first week clear, which the journey’s “No clashes this week” rests on', () => {
		const first = weeks[0]!;
		expect(first.week.startsOn).toBe(SCENARIO_START);
		expect(first.r.before.evaluation.grade).toBe('clear');
		expect(first.r.before.evaluation.findings.filter((f) => f.severity === 'avoid')).toEqual([]);
	});

	it('leaves no unresolved avoid finding in any planned week of version 1', () => {
		expect(weeks.length).toBe(plan.blocks.flatMap((b) => b.weeks).length);
		for (const { week, r } of weeks) {
			const open = r.before.evaluation.findings.filter(
				(f) => f.severity === 'avoid' && !f.resolution
			);
			expect(open, week.startsOn).toEqual([]);
		}
	});

	it('records the shared day changes once for the block, citing the session in each week', () => {
		const shared = plan.decisions.filter(
			(d) => d.kind === 'schedule_repaired' && d.refs.length > 1
		);
		expect(shared.length).toBeGreaterThan(0);
		for (const d of shared) {
			const titles = d.refs.map((ref) => (resolve(plan, ref) as SessionPlan).title);
			expect(new Set(titles)).toEqual(new Set([d.evidence.session]));
			const days = d.refs.map((ref) => weekdayOf((resolve(plan, ref) as SessionPlan).date));
			expect(new Set(days).size).toBe(1);
		}
	});
});

describe('the building weeks’ shared days', () => {
	it.each(['journeyHybrid', 'hypertrophyBlock'] as const)(
		'%s keeps each generated session on one weekday and time in every accumulation week',
		(key) => {
			// journeyHybrid's baseline keeps its own days: the shared ones would leave it an avoid.
			const plan = generateProgram(inputOf(M7_SCENARIOS[key]()), OPTIONS);
			const weeks = plan.blocks[0]!.weeks.filter((w) => w.kind === 'accumulation');
			expect(weeks.length).toBeGreaterThan(1);
			const slots = (week: WeekPlan) =>
				week.sessions
					.filter((s) => s.source === 'generator')
					.map((s) => `${s.title} ${weekdayOf(s.date)} ${s.timeOfDay}`)
					.sort();
			for (const week of weeks) expect(slots(week), week.startsOn).toEqual(slots(weeks[0]!));
		}
	);
});

describe('the schedule stage on its own', () => {
	it.each(['beginner', 'meetPrep', 'offSeason'] as const)(
		'%s: changes nothing where placement already succeeded',
		(key) => {
			const profile = key === 'beginner' ? SCENARIOS.beginner() : M7_SCENARIOS[key]();
			const { draft, context } = beforeSchedule(profile);
			const log = new DecisionLog();
			const after = schedule(draft, { ...context, log });
			expect(after.blocks).toEqual(draft.blocks);
			expect(log.list()).toEqual([]);
		}
	);

	/**
	 * multiGoal's draft with each week's Strength A swapped onto Wednesday, the day before
	 * Thursday's class, made sparring: a clash placement would not leave.
	 */
	function legsBeforeSparring() {
		const { draft, context } = beforeSchedule(M7_SCENARIOS.multiGoal());
		const blocks = structuredClone(draft.blocks);
		for (const week of blocks[0]!.weeks) {
			const legs = week.sessions.find((s) => s.title === 'Strength A')!;
			const easy = week.sessions.find((s) => s.title === 'Easy run' && weekdayOf(s.date) === 'wed');
			const thursday = week.sessions.find(
				(s) => s.source === 'commitment' && weekdayOf(s.date) === 'thu'
			)!;
			if (thursday.kind === 'other') thursday.details.kind = 'sparring';
			if (easy) [legs.date, easy.date] = [easy.date, legs.date];
			week.sessions.sort((a, b) => a.date.localeCompare(b.date) || a.orderInDay - b.orderInDay);
		}
		const log = new DecisionLog();
		const given: Draft = { ...draft, blocks };
		return { given, after: schedule(given, { ...context, log }), log };
	}
	const heavyLegs = (s: SessionPlan) => demandOf(s, catalogueTraits).heavyLower;

	it('multiGoal moves heavy legs away from the day before Thursday’s sparring', () => {
		const { given, after, log } = legsBeforeSparring();
		const weeks = after.blocks[0]!.weeks;
		const wasBefore = given.blocks[0]!.weeks.filter((w) =>
			w.sessions.some((s) => heavyLegs(s) && weekdayOf(s.date) === 'wed')
		);
		expect(wasBefore.length).toBeGreaterThan(0);
		for (const week of weeks) {
			const wednesday = week.sessions.filter((s) => weekdayOf(s.date) === 'wed');
			expect(wednesday.filter(heavyLegs), week.startsOn).toEqual([]);
		}
		// One decision for the block, citing Strength A in each building week, all on one day.
		// One decision for the block moves it in the building weeks, citing it on one day in each.
		const decision = log
			.list()
			.find((d) => d.kind === 'schedule_repaired' && d.evidence.from === 'Wednesday morning');
		expect(decision!.evidence.session).toBe('Strength A');
		expect(decision!.refs.length).toBeGreaterThan(1);
		const cited = decision!.refs.map((ref) =>
			resolve({ blocks: after.blocks } as ProgramPlan, ref)
		);
		expect(cited.every((s) => (s as SessionPlan).title === 'Strength A')).toBe(true);
		expect(
			new Set(
				cited.map((s) => (s as SessionPlan).date.length && weekdayOf((s as SessionPlan).date))
			).size
		).toBe(1);
	});

	/**
	 * runnerLifter, its squat 1RM blank so its loads follow the RPE, with each week's squat session
	 * swapped (or moved) onto Friday, the day before Saturday's long run, and only Friday and Saturday open at
	 * one time of day: no other day, swap or double avoids the clash, so the squat session is eased.
	 */
	function squatBeforeLongRun(key: 'runnerLifter' | 'marathonTaper') {
		const profile = M7_SCENARIOS[key]();
		profile.baselines = profile.baselines.filter((b) => b.lift !== 'back_squat');
		const { draft, context } = beforeSchedule(profile);
		const blocks = structuredClone(draft.blocks);
		for (const week of blocks[0]!.weeks) {
			const legs = week.sessions.find((s) => s.kind === 'strength' && squatOf(s))!;
			const friday = week.sessions.find((s) => weekdayOf(s.date) === 'fri');
			if (friday) [legs.date, friday.date] = [friday.date, legs.date];
			else legs.date = addDays(week.startsOn, 4);
			week.sessions.sort((a, b) => a.date.localeCompare(b.date) || a.orderInDay - b.orderInDay);
		}
		const demand = draft.demand!;
		const budget = { ...demand.budget, days: ['fri', 'sat'] as Weekday[] };
		const input = { ...context.input, preferredTimes: ['morning' as const] };
		const log = new DecisionLog();
		const given: Draft = { ...draft, blocks, demand: { ...demand, budget } };
		return { given, after: schedule(given, { ...context, input, log }), log, input };
	}
	const squatOf = (s: SessionPlan) =>
		s.kind === 'strength' ? s.exercises.find((e) => e.baselineLift === 'back_squat') : undefined;
	const top = (e: PlannedExercisePlan) => e.sets.find((l) => l.role === 'top')!;

	// marathonTaper's block opens with a taper, not a baseline: M3 sets the squat's baseline there.
	it.each(['runnerLifter', 'marathonTaper'] as const)(
		'%s: an eased squat session’s loads equal M3’s at its new target RPE, and it still fits its minutes',
		(key) => {
			const { given, after, log, input } = squatBeforeLongRun(key);
			// The first week whose cap is above the eased RPE: its squat comes down.
			const w = given.blocks[0]!.weeks.findIndex((x) => x.targets.rpeCap > EASE.rpe);
			expect(w).toBe(key === 'runnerLifter' ? 1 : 0);
			const friday = (week: WeekPlan) => week.sessions.find((s) => weekdayOf(s.date) === 'fri')!;
			const was = friday(given.blocks[0]!.weeks[w]!);
			const now = friday(after.blocks[0]!.weeks[w]!);
			const at = `blocks.0.weeks.${w}.sessions.${after.blocks[0]!.weeks[w]!.sessions.indexOf(now)}`;
			const eased = log.list().filter((d) => d.kind === 'load_eased' && d.refs.includes(at));
			expect(eased).toHaveLength(1);
			expect(eased[0]!.evidence).toMatchObject({ session: was.title, rpe: EASE.rpe });
			expect([was.title, was.intensity, now.intensity]).toEqual([
				now.title,
				'hard',
				EASE.intensity
			]);
			expect(top(squatOf(was)!).targetRpe).toBeGreaterThan(EASE.rpe);
			expect(top(squatOf(now)!).targetRpe).toBe(EASE.rpe);
			// M3's progression, given the week with its cap at the eased RPE, loads the squat the same.
			const block: BlockPlan = given.blocks[0]!;
			const capped = block.weeks.map((x, i) =>
				i === w ? { ...x, targets: { ...x.targets, rpeCap: EASE.rpe } } : x
			);
			const m3 = squatOf(friday(progressWeeks(capped, input)[w]!))!;
			const loads = (e: PlannedExercisePlan) =>
				e.sets.map(({ role, loadKind, loadValue, loadBasis, reference1rm }) => ({
					role,
					loadKind,
					loadValue,
					loadBasis,
					reference1rm
				}));
			expect(loads(squatOf(now)!)).toEqual(loads(m3));
			// A first appearance is a baseline set, found on the day; a later one comes down.
			if (key === 'marathonTaper') expect(top(squatOf(now)!).loadValue).toBeNull();
			else expect(top(squatOf(now)!).loadValue).toBeLessThan(top(squatOf(was)!).loadValue!);
			// It still fits its minutes, and its sRPE follows its new target.
			expect(now.estMinutes).toBe(estimateMinutes(now as StrengthSessionPlan, input));
			expect(now.estMinutes).toBeLessThanOrEqual(input.sessionMinutes);
			expect([now.targetRpe, now.estLoad]).toEqual([EASE.rpe, sessionLoadOf(now)]);
		}
	);
});

describe('the plan budget and M6', () => {
	it('keeps longSeason’s decisions within PLAN_BUDGET', () => {
		const plan = generateProgram(inputOf(M7_SCENARIOS.longSeason()), OPTIONS);
		expect(plan.decisions.length).toBeLessThanOrEqual(PLAN_BUDGET.decisions);
	});
});
