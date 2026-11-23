/**
 * generator-schedule: the schedule stage repairs every planned week with the week scheduler, so
 * no avoid finding, judged with the load and the priorities, stands unless a higher-priority goal
 * keeps it with a priority_tradeoff decision; building weeks share their days; an eased session
 * is loaded again at its new target RPE and still fits its minutes; the journey's first week is
 * pinned.
 */
import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, weekdayOf } from '../calendar';
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
import { CLASH_KEPT_RULES } from '../training/vocabulary';
import { validate } from '../validation';
import { DecisionLog } from './decisions';
import { evaluateWeek } from './evaluate/week';
import { demandOf, catalogueTraits } from './interference';
import { loadModel } from './load/fatigue';
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
import type { Draft, GenerateOptions, Periodisation, StageContext } from './stage';
import { prepare } from './stages/prepare';
import { OWN_WEEKS, schedule } from './stages/schedule';
import { estimateMinutes } from './timefit';

const OPTIONS = { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START };
const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });

/** Every stage but schedule run on `profile`, the draft schedule receives, and its context. */
function beforeSchedule(profile: TrainingProfile, options: GenerateOptions = OPTIONS) {
	const log = new DecisionLog();
	const prepared = prepare(inputOf(profile), options, log);
	const context: StageContext = { input: prepared.input, options, log };
	let draft = firstDraft(prepared);
	for (const stage of STAGES.filter((s) => s.name !== 'schedule')) {
		draft = stage.run(draft, context);
	}
	return { draft, context, periodisation: prepared.periodisation };
}

/** A scenario's profile, from the M7 set or the M3 set (journey is one of M3's). */
const scenarioOf = (key: string): TrainingProfile =>
	key in M7_SCENARIOS ? M7_SCENARIOS[key as M7ScenarioKey]() : SCENARIOS[key as ScenarioKey]();

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
 * Each planned week of `plan` judged by evaluateWeek alone, never the stage's own context: its
 * sessions, the day before and the next Monday's commitments beside them (as placement judges a
 * week), with the load of the plan's week before as planned (the previous block's last week for a
 * block's first), the week's effective priorities, kind and targets, the goals' events and the
 * leader's level.
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
			const sessions = [...week.sessions.map((s, i) => ({ ...s, lineage: `${i}` })), ...around];
			const from = addDays(week.startsOn, -7);
			const evaluation = evaluateWeek(sessions, {
				openDates: openDates(week, days, plan.firstPlannedDay),
				today: from,
				context: {
					load: {
						days: loadModel({
							planned: [...before.filter((s) => s.date !== eve), ...sessions],
							logged: [],
							from,
							to: week.endsOn,
							today: from
						}),
						logged: []
					},
					priorities: periodisation?.prioritiesByWeek.find((p) => p.startsOn === week.startsOn)
						?.priorities,
					week: { kind: week.kind, phase: block.phase, targets: week.targets },
					events,
					...(level && { experience: level })
				}
			});
			before = week.sessions;
			return { b, w, week, evaluation };
		})
	);
}

function generated(profile: TrainingProfile, options: GenerateOptions = OPTIONS) {
	const { draft, context, periodisation } = beforeSchedule(profile, options);
	const plan = generateProgram(inputOf(profile), options);
	const weeks = judgeWeeks(plan, context.input, periodisation, draft.demand!.budget.days);
	return { plan, weeks };
}

/** Whether a decision explains a clash a week keeps: its rule is one of CLASH_KEPT_RULES. */
const explains = (d: { ruleKey: string }) => CLASH_KEPT_RULES.includes(d.ruleKey);

/**
 * Each avoid finding a judged week keeps, naming a session of its own, that no decision of the plan
 * explains (its session's ref in a decision citing it). Empty when every clash is gone or explained.
 */
function unexplained(plan: ProgramPlan, weeks: ReturnType<typeof judgeWeeks>) {
	const explained = new Set(plan.decisions.filter(explains).flatMap((d) => d.refs));
	return weeks.flatMap(({ b, w, week, evaluation }) =>
		evaluation.findings
			.filter(
				(f) =>
					f.severity === 'avoid' &&
					f.resolution?.kind !== 'commitment_fixed' &&
					f.sessions.some((s) => !s.lineage!.startsWith('around'))
			)
			.filter(
				(f) =>
					!f.sessions.some(
						(s) =>
							!s.lineage!.startsWith('around') &&
							explained.has(`blocks.${b}.weeks.${w}.sessions.${s.lineage}`)
					)
			)
			.map((f) => `${week.startsOn} ${f.message}`)
	);
}

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
		'%s: every avoid finding a week keeps is explained by a priority_tradeoff or schedule_kept',
		(_, profile) => {
			const { plan, weeks } = generated(profile());
			// A clash between fixed commitments alone is the owner's, not the generator's, and one about
			// the day before alone is judged beside the week, not in it: neither is listed.
			expect(unexplained(plan, weeks)).toEqual([]);
			expect(validate(programPlanSchema, plan)).toEqual({ ok: true, data: plan });
		}
	);

	// Each scenario is generated twice: the slowest takes over the default 5 s on a busy machine.
	it.each(ALL)(
		'%s: every decision ref resolves, and the plan is the same every run',
		{ timeout: 60_000 },
		(_, p) => {
			const plan = generateProgram(inputOf(p()), OPTIONS);
			for (const d of plan.decisions) {
				for (const ref of d.refs) expect(resolve(plan, ref), `${d.kind} ${ref}`).toBeDefined();
				expect(RULE_BY_ID.has(d.ruleKey), d.ruleKey).toBe(true);
			}
			expect(JSON.stringify(generateProgram(inputOf(p()), OPTIONS))).toBe(JSON.stringify(plan));
		}
	);
});

/**
 * Scenarios planned from a Monday other than SCENARIO_START: the same days meet other weeks'
 * commitments and loads, so a clash can stand in a week the scenario's own start never shows.
 */
const FROM_MONDAY: [string, () => TrainingProfile, string][] = [
	['multiGoal from 2026-11-16', M7_SCENARIOS.multiGoal, '2026-11-16'],
	['multiGoal from 2026-12-14', M7_SCENARIOS.multiGoal, '2026-12-14'],
	['longSeason from 2026-11-16', M7_SCENARIOS.longSeason, '2026-11-16']
];

describe('every scenario planned from another Monday', () => {
	it.each(FROM_MONDAY)(
		'%s: every avoid finding a week keeps is explained by a clash-keeping decision',
		{ timeout: 60_000 },
		(_, profile, startsOn) => {
			const { plan, weeks } = generated(profile(), { startsOn, firstPlannedDay: startsOn });
			expect(unexplained(plan, weeks)).toEqual([]);
			expect(validate(programPlanSchema, plan)).toEqual({ ok: true, data: plan });
		}
	);
});

describe('journeyHybrid, the Playwright journey’s profile', () => {
	const { plan, weeks } = generated(M7_SCENARIOS.journeyHybrid());

	it('grades its first week clear, which the journey’s “No clashes this week” rests on', () => {
		const first = weeks[0]!;
		expect(first.week.startsOn).toBe(SCENARIO_START);
		expect(first.evaluation.grade).toBe('clear');
		expect(first.evaluation.findings.filter((f) => f.severity === 'avoid')).toEqual([]);
	});

	it('judges every planned week of version 1', () => {
		expect(weeks.length).toBe(plan.blocks.flatMap((b) => b.weeks).length);
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
		'%s: changes nothing where placement already succeeded, and only records the clashes it keeps',
		(key) => {
			const profile = key === 'beginner' ? SCENARIOS.beginner() : M7_SCENARIOS[key]();
			const { draft, context } = beforeSchedule(profile);
			const log = new DecisionLog();
			const after = schedule(draft, { ...context, log });
			expect(after.blocks).toEqual(draft.blocks);
			const changed = log.list().filter((d) => !explains(d));
			expect(changed).toEqual([]);
			// offSeason keeps a clash of its own (a strength session over a run), so it logs that as kept.
			if (key !== 'offSeason') expect(log.list()).toEqual([]);
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

describe('a block pattern that ends hard on Sunday', () => {
	/**
	 * journeyHybrid's draft with each accumulation week's Long run moved to Sunday: the days the block
	 * shares end on a hard day, so the next week's Monday follows it.
	 */
	function sundayPattern() {
		const { draft, context } = beforeSchedule(M7_SCENARIOS.journeyHybrid());
		const blocks = structuredClone(draft.blocks);
		for (const week of blocks[0]!.weeks) {
			if (week.kind !== 'accumulation') continue;
			week.sessions.find((s) => s.title === 'Long run')!.date = addDays(week.startsOn, 6);
			week.sessions.sort((a, b) => a.date.localeCompare(b.date) || a.orderInDay - b.orderInDay);
		}
		const log = new DecisionLog();
		const after = schedule({ ...draft, blocks }, { ...context, log });
		return { after, log };
	}

	it('from its second week, Monday is not the hardest session and the hard session sits later', () => {
		const { after, log } = sundayPattern();
		const weeks = after.blocks[0]!.weeks.filter((w, i) => i > 0 && w.kind === 'accumulation');
		expect(weeks.length).toBeGreaterThan(0);
		for (const week of weeks) {
			const generated = week.sessions.filter((s) => s.source === 'generator');
			const hardest = generated.reduce((a, b) => (b.estLoad > a.estLoad ? b : a));
			expect(weekdayOf(hardest.date), week.startsOn).not.toBe('mon');
			const tempo = week.sessions.find((s) => s.title === 'Tempo run')!;
			expect(daysBetween(week.startsOn, tempo.date), week.startsOn).toBeGreaterThan(0);
		}
		// The move is recorded once for the block, citing the Tempo run in each week it changed.
		const moved = log
			.list()
			.find(
				(d) =>
					d.kind === 'schedule_repaired' &&
					d.evidence.session === 'Tempo run' &&
					d.evidence.from === 'Monday morning'
			);
		expect(moved).toBeDefined();
	});
});

describe('a clash kept against the week before as planned', () => {
	const FOUND = 'Found against the week before as planned, and kept';
	const SHARED = `${FOUND} because the block shares its days: its days repeat each week, so this pairing with the week before stays.`;
	const OWN = `${FOUND}: this week keeps its own days.`;

	/** Each found clash says the block shares its days only when a week it cites is a building week. */
	function saysOwnDays(plan: ProgramPlan) {
		const found = plan.decisions.filter(
			(d) => d.kind === 'schedule_kept' && String(d.evidence.reason).startsWith(FOUND)
		);
		const ownWeek = (d: (typeof found)[number]) =>
			d.refs.some((ref) =>
				OWN_WEEKS.includes((resolve(plan, ref.split('.sessions.')[0]!) as WeekPlan).kind)
			);
		expect(found.map((d) => d.evidence.reason)).toEqual(
			found.map((d) => (ownWeek(d) ? OWN : SHARED))
		);
	}

	it.each(ALL)(
		'%s: says the block shares its days only in a week that shares them',
		(_, profile) => {
			saysOwnDays(generated(profile()).plan);
		}
	);

	it.each(FROM_MONDAY)('%s: says the same', (_, profile, startsOn) => {
		saysOwnDays(generated(profile(), { startsOn, firstPlannedDay: startsOn }).plan);
	});
});

describe('the clashes journeyHybrid, journey and offSeason keep', () => {
	it.each(['journeyHybrid', 'journey', 'offSeason'] as const)(
		'%s: every avoid finding a week keeps carries a schedule_kept or priority_tradeoff decision',
		(key) => {
			const { plan, weeks } = generated(scenarioOf(key));
			expect(unexplained(plan, weeks)).toEqual([]);
		}
	);
});

describe('the schedule stage run twice', () => {
	it.each(['journeyHybrid', 'multiGoal', 'journey', 'offSeason'] as const)(
		'%s: the second run changes no session',
		(key) => {
			const { draft, context } = beforeSchedule(scenarioOf(key));
			const once = schedule(draft, { ...context, log: new DecisionLog() });
			const log = new DecisionLog();
			const twice = schedule({ ...draft, blocks: once.blocks }, { ...context, log });
			expect(twice.blocks).toEqual(once.blocks);
			const changed = log.list().filter((d) => !explains(d));
			expect(changed).toEqual([]);
		}
	);
});

describe('the plan budget and M6', () => {
	it('keeps longSeason’s decisions within PLAN_BUDGET', () => {
		const plan = generateProgram(inputOf(M7_SCENARIOS.longSeason()), OPTIONS);
		expect(plan.decisions.length).toBeLessThanOrEqual(PLAN_BUDGET.decisions);
	});
});
