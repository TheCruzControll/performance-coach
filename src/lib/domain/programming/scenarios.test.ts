/**
 * The generator's scenario suite (m3/28), through the package's public entry point: the M3
 * brief's five scenarios, the journey profile and the minimal onboarding profile, each composed
 * end to end by generateProgram. Assertions are pinned to rules (no overhead tag, an equipment
 * subset, the interference demands, the load rules), never to exercise names. Then, for every
 * scenario: the session length after every stage, determinism, a 'this_week' start, rule-clean
 * weeks with every 'avoid' explained, every decision's kind and rationale, and the program_purpose
 * decision.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDays, daysBetween, weekdayOf } from '../calendar';
import { CATALOGUE, catalogueByKey } from '../exercises/index';
import type { CatalogueExercise } from '../exercises/index';
import type { Commitment, TrainingProfile } from '../profile/types';
import { BASELINE_INSTRUCTION } from '../training/describe';
import { programPlanSchema } from '../training/schemas';
import type {
	PlannedExercisePlan,
	ProgramPlan,
	SessionPlan,
	StrengthSessionPlan,
	WeekPlan
} from '../training/types';
import { DECISION_KINDS } from '../training/vocabulary';
import { validate } from '../validation';
import { buildProgrammingInput, checkWeek, generateProgram } from './index';
import type { ProgrammingInput } from './index';
import { demandOf } from './interference';
import { seededRandom } from './random';
import { GYM_PRESETS } from './rules/defaults';
import { SCENARIO_START, SCENARIOS, scenarioDay } from './scenarios';
import type { ScenarioKey } from './scenarios';
import { estimateMinutes } from './timefit';

const KEYS = Object.keys(SCENARIOS) as ScenarioKey[];
const MONDAY = { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START };
const THURSDAY = { startsOn: SCENARIO_START, firstPlannedDay: scenarioDay(1, 3) };

const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });

const cache = new Map<string, { input: ProgrammingInput; plan: ProgramPlan }>();
/** A scenario's input and its plan from `start`, generated once for the suite. */
function scenario(key: ScenarioKey, start: typeof MONDAY = MONDAY) {
	const id = `${key} ${start.firstPlannedDay}`;
	let found = cache.get(id);
	if (!found) {
		const input = inputOf(SCENARIOS[key]());
		found = { input, plan: generateProgram(input, start) };
		cache.set(id, found);
	}
	return found;
}

interface Placed {
	path: string;
	session: SessionPlan;
}

const weeksOf = (plan: ProgramPlan) => plan.blocks.flatMap((b) => b.weeks);
/** Every planned session, with the plan path decisions cite it by. */
const placedIn = (plan: ProgramPlan): Placed[] =>
	plan.blocks.flatMap((block, b) =>
		block.weeks.flatMap((week, w) =>
			week.sessions.map((session, s) => ({ path: `blocks.${b}.weeks.${w}.sessions.${s}`, session }))
		)
	);
const isStrength = (s: SessionPlan): s is StrengthSessionPlan => s.kind === 'strength';
const strengthIn = (sessions: readonly SessionPlan[]) => sessions.filter(isStrength);
const entryOf = (planned: PlannedExercisePlan): CatalogueExercise =>
	catalogueByKey.get('key' in planned.exercise ? planned.exercise.key : '')!;
const exercisesIn = (plan: ProgramPlan) =>
	weeksOf(plan).flatMap((w) => strengthIn(w.sessions).flatMap((s) => s.exercises.map(entryOf)));
/** A main lift: a top set, and a baseline lift its load is a share of. */
const mainLifts = (sessions: readonly SessionPlan[]) =>
	strengthIn(sessions).flatMap((s) =>
		s.exercises.filter((e) => e.baselineLift && e.sets.some((l) => l.role === 'top'))
	);
const wordsOf = (plan: ProgramPlan) =>
	plan.decisions.map((d) => `${d.summary} ${d.why}`).join('\n');
const avoidIn = (plan: ProgramPlan) =>
	checkWeek(weeksOf(plan).flatMap((w) => w.sessions)).filter((v) => v.severity === 'avoid');

const LOWER = ['squat', 'hinge', 'lunge'];
const UPPER = ['horizontal_push', 'vertical_push', 'horizontal_pull', 'vertical_pull'];

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('the brief’s scenarios', () => {
	it('strength-only beginner, every 1RM blank: 3 full-body sessions on non-consecutive days, main lifts by RPE with recording instructions', () => {
		const { plan } = scenario('beginner');
		expect(plan.decisions.find((d) => d.kind === 'split_chosen')?.ruleKey).toBe(
			'strength.full_body'
		);
		const lifting = weeksOf(plan).flatMap((w) => strengthIn(w.sessions));
		for (const week of weeksOf(plan)) {
			expect(week.sessions.map((s) => s.kind)).toEqual(['strength', 'strength', 'strength']);
		}
		lifting.slice(1).forEach((s, i) => {
			expect(daysBetween(lifting[i]!.date, s.date)).toBeGreaterThanOrEqual(2);
		});
		for (const s of lifting) {
			const patterns = s.exercises.map((e) => entryOf(e).pattern);
			expect(patterns.some((p) => LOWER.includes(p))).toBe(true);
			expect(patterns.some((p) => UPPER.includes(p))).toBe(true);
		}
		const [week1] = weeksOf(plan);
		for (const s of strengthIn(week1!.sessions)) expect(mainLifts([s]).length).toBeGreaterThan(0);
		for (const main of mainLifts(week1!.sessions)) {
			expect(main.instructions).toBe(BASELINE_INSTRUCTION);
			const top = main.sets.find((l) => l.role === 'top')!;
			expect(top).toMatchObject({ loadKind: 'rpe_based', loadValue: null });
			expect(top.targetRpe).toBeLessThanOrEqual(week1!.targets.rpeCap);
		}
		const loads = weeksOf(plan).flatMap((w) => mainLifts(w.sessions).flatMap((e) => e.sets));
		expect(loads.filter((l) => l.loadKind === 'percent_1rm')).toEqual([]);
	});

	it('powerlifter with measured 1RMs: squat, bench and deadlift at 72.5 % or less in week 1, of the measured 1RM', () => {
		const { plan, input } = scenario('powerlifter');
		const [week1, ...later] = weeksOf(plan);
		const mains = mainLifts(week1!.sessions);
		expect(new Set(mains.map((e) => e.baselineLift))).toEqual(
			new Set(['back_squat', 'bench_press', 'deadlift'])
		);
		for (const main of mains) {
			const oneRepMax = input.baselines[main.baselineLift!]!;
			expect(oneRepMax.kind).toBe('measured');
			const working = main.sets.filter((l) => l.role === 'top' || l.role === 'back_off');
			expect(working.length).toBeGreaterThan(1);
			for (const line of working) {
				expect(line).toMatchObject({
					loadKind: 'percent_1rm',
					loadBasis: 'measured',
					reference1rm: oneRepMax.kg,
					reference1rmUnit: 'kg'
				});
				expect(line.loadValue).toBeLessThanOrEqual(0.725);
			}
		}
		const sets = later.flatMap((w) => mainLifts(w.sessions).flatMap((e) => e.sets));
		expect(sets.filter((l) => l.loadBasis !== null && l.loadBasis !== 'measured')).toEqual([]);
		expect(plan.decisions.filter((d) => d.kind === 'load_basis').map((d) => d.ruleKey)).toEqual([
			'loads.measured',
			'loads.measured',
			'loads.measured'
		]);
	});

	it('hybrid strength + marathon + Muay Thai Tue/Thu: classes on Tue/Thu, a weekend long run, no heavy lower body the day before either, and priority decisions', () => {
		const profile = SCENARIOS.hybrid();
		const { plan } = scenario('hybrid');
		for (const week of weeksOf(plan)) {
			const muayThai = week.sessions.filter((s) => s.discipline === 'muay_thai');
			expect(muayThai.map((s) => [weekdayOf(s.date), s.source])).toEqual([
				['tue', 'commitment'],
				['thu', 'commitment']
			]);
			const long = week.sessions.filter((s) => s.type === 'long_run');
			expect(long).toHaveLength(1);
			expect(['sat', 'sun']).toContain(weekdayOf(long[0]!.date));
		}
		// Across the whole plan, so a Sunday's lifting before Monday's class would count too.
		const sessions = weeksOf(plan).flatMap((w) => w.sessions);
		const heavyLower = sessions.filter((s) => demandOf(s).heavyLower);
		expect(heavyLower.length).toBeGreaterThan(0);
		const hardNext = sessions.filter((s) => demandOf(s).hardCombat || demandOf(s).longRun);
		for (const s of heavyLower) {
			expect(hardNext.filter((h) => h.date === addDays(s.date, 1))).toEqual([]);
		}
		expect(avoidIn(plan)).toEqual([]);
		const [first, second] = profile.goals;
		const priority = plan.decisions.filter(
			(d) =>
				d.kind === 'priority_tradeoff' &&
				d.evidence.kept === first!.title &&
				d.evidence.given === second!.title
		);
		expect(priority.length).toBeGreaterThan(0);
		const at = new Map(placedIn(plan).map((p) => [p.path, p.session]));
		for (const ref of priority.flatMap((d) => d.refs)) {
			expect(at.get(ref)?.discipline).toBe(second!.disciplines[0]);
		}
	});

	it('injured shoulder: no overhead exercise in any week, and a decision saying why', () => {
		const { plan } = scenario('injuredShoulder');
		const exercises = exercisesIn(plan);
		expect(exercises.length).toBeGreaterThan(0);
		expect(exercises.filter((e) => e.tags.includes('overhead'))).toEqual([]);
		const because = plan.decisions.filter(
			(d) =>
				(d.kind === 'exercise_substituted' || d.kind === 'exercise_excluded') &&
				d.why.includes('shoulder injury rules out overhead work')
		);
		expect(because.length).toBeGreaterThan(0);
	});

	it('dumbbells only: only dumbbell, bench and bodyweight exercises', () => {
		const { plan, input } = scenario('dumbbellsOnly');
		expect(input.equipment).toEqual(['bench', 'dumbbells']);
		const exercises = exercisesIn(plan);
		for (const e of exercises) {
			expect(e.equipment.filter((item) => !input.equipment.includes(item))).toEqual([]);
		}
		for (const week of weeksOf(plan)) {
			for (const s of strengthIn(week.sessions)) {
				expect(s.exercises.some((e) => entryOf(e).equipment.includes('dumbbells'))).toBe(true);
			}
		}
	});

	it('the journey (fight + marathon + strength, blank 1RMs): rule-clean, with both events named in its decisions', () => {
		const profile = SCENARIOS.journey();
		const { plan } = scenario('journey');
		expect(avoidIn(plan)).toEqual([]);
		const words = wordsOf(plan);
		const dated = profile.goals.filter((g) => g.eventDate !== null);
		expect(dated).toHaveLength(2);
		for (const goal of dated) expect(words).toContain(`${goal.title} on ${goal.eventDate}`);
		const kinds = new Set(weeksOf(plan).flatMap((w) => w.sessions.map((s) => s.discipline)));
		expect(kinds).toEqual(new Set(['muay_thai', 'distance_running', 'strength']));
		const loads = weeksOf(plan).flatMap((w) => mainLifts(w.sessions).flatMap((e) => e.sets));
		expect(loads.length).toBeGreaterThan(0);
		expect(loads.filter((l) => l.loadKind === 'percent_1rm')).toEqual([]);
	});

	it('the minimal onboarding profile: a valid 3-day plan on any days, a commercial-gym selection, 60-minute sessions and one default_assumed per assumption', () => {
		const { plan, input } = scenario('minimal');
		expect(validate(programPlanSchema, plan)).toEqual({ ok: true, data: plan });
		expect(input.availableDays).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
		for (const week of weeksOf(plan)) {
			expect(new Set(week.sessions.map((s) => s.date)).size).toBe(3);
			expect(week.sessions).toHaveLength(3);
		}
		expect(input.equipment).toEqual([...GYM_PRESETS.commercial]);
		for (const e of exercisesIn(plan)) {
			expect(e.equipment.filter((item) => !GYM_PRESETS.commercial.includes(item))).toEqual([]);
		}
		expect(input.sessionMinutes).toBe(60);
		for (const { session } of placedIn(plan)) expect(session.estMinutes).toBeLessThanOrEqual(60);
		const assumed = plan.decisions.filter((d) => d.kind === 'default_assumed');
		expect(assumed.map((d) => d.ruleKey)).toEqual(input.assumptions.map((a) => a.ruleKey));
		expect(input.assumptions.map((a) => a.ruleKey)).toEqual(
			expect.arrayContaining(['defaults.available_days', 'defaults.equipment'])
		);
		for (const d of assumed) expect(d.why).toMatch(/Change it in Profile → \S/);
	});
});

/** The hybrid scenario with sessions too short for its long run. */
function hybridShort(): TrainingProfile {
	const p = SCENARIOS.hybrid();
	p.schedule.sessionMinutes = 45;
	return p;
}

describe('the session length, after every stage', () => {
	const generate = (make: () => TrainingProfile) => {
		const input = inputOf(make());
		return { input, plan: generateProgram(input, MONDAY) };
	};
	const cases: [string, () => ReturnType<typeof scenario>][] = [
		...KEYS.map((key): [string, () => ReturnType<typeof scenario>] => [key, () => scenario(key)]),
		['hybrid with 45-minute sessions', () => generate(hybridShort)]
	];

	it.each(cases)(
		'%s: every generated session but the long run fits it in every week; commitments keep their length',
		(_, planned) => {
			const { input, plan } = planned();
			const longRunRefs = plan.decisions
				.filter((d) => d.kind === 'priority_tradeoff' && d.ruleKey === 'running.long_run_length')
				.flatMap((d) => d.refs);
			for (const { path, session: s } of placedIn(plan)) {
				if (s.source === 'commitment') {
					const told = input.commitments[input.refs.commitments.indexOf(s.commitmentRef!)]!;
					expect(s.estMinutes).toBe(told.durationMinutes);
					if (s.kind === 'other') expect(s.details.durationMinutes).toBe(told.durationMinutes);
					continue;
				}
				if (s.type === 'long_run') {
					if (s.estMinutes > input.sessionMinutes) expect(longRunRefs).toContain(path);
					continue;
				}
				expect(s.estMinutes).toBeLessThanOrEqual(input.sessionMinutes);
				if (s.kind === 'strength') expect(s.estMinutes).toBe(estimateMinutes(s, input));
				if (s.kind === 'other') {
					expect(s.details.durationMinutes).toBeLessThanOrEqual(input.sessionMinutes);
				}
			}
		}
	);

	it('lets a long run outrun short sessions only with the decision saying so', () => {
		const input = inputOf(hybridShort());
		const plan = generateProgram(input, MONDAY);
		const over = placedIn(plan).filter(
			({ session: s }) => s.type === 'long_run' && s.estMinutes > input.sessionMinutes
		);
		expect(over.length).toBeGreaterThan(0);
		const decision = plan.decisions.find((d) => d.ruleKey === 'running.long_run_length');
		expect(decision).toMatchObject({ kind: 'priority_tradeoff', refs: over.map((o) => o.path) });
		expect(decision!.why).toContain('45-minute sessions');
	});
});

/** `profile` with every list it holds in another order, by `seed`. */
function reordered(profile: TrainingProfile, seed: number): TrainingProfile {
	const random = seededRandom(seed);
	const mix = <T>(items: readonly T[]) => random.shuffle(items);
	const p = structuredClone(profile);
	const commitment = (c: Commitment) => ({ ...c, days: mix(c.days) });
	return {
		...p,
		bodyWeight: mix(p.bodyWeight),
		goals: mix(p.goals.map((g) => ({ ...g, disciplines: mix(g.disciplines) }))),
		experience: mix(p.experience),
		baselines: mix(p.baselines),
		running: p.running && { ...p.running, races: mix(p.running.races) },
		equipment: p.equipment && {
			...p.equipment,
			equipment: mix(p.equipment.equipment),
			homeEquipment: mix(p.equipment.homeEquipment)
		},
		injuries: mix(p.injuries.map((i) => ({ ...i, avoid: mix(i.avoid) }))),
		exercises: mix(p.exercises),
		schedule: {
			...p.schedule,
			availableDays: mix(p.schedule.availableDays),
			preferredTimes: mix(p.schedule.preferredTimes),
			commitments: mix(p.schedule.commitments.map(commitment))
		}
	};
}

describe('determinism', () => {
	it.each(KEYS)('%s: the same input gives deep-equal plans, and is left as it was', (key) => {
		const { input, plan } = scenario(key);
		expect(generateProgram(input, MONDAY)).toEqual(plan);
		const fresh = inputOf(SCENARIOS[key]());
		expect(input).toEqual(fresh);
		expect(generateProgram(fresh, MONDAY)).toEqual(plan);
	});

	it.each(KEYS)('%s: the profile’s rows in any order give the same plan', (key) => {
		const { plan } = scenario(key);
		for (const seed of [1, 2, 3]) {
			expect(generateProgram(inputOf(reordered(SCENARIOS[key](), seed)), MONDAY)).toEqual(plan);
		}
	});

	it('really reorders the rows it shuffles', () => {
		const ids = (p: TrainingProfile) => p.goals.map((g) => g.id);
		const journey = SCENARIOS.journey();
		const orders = [1, 2, 3].map((seed) => ids(reordered(journey, seed)).join());
		expect(orders.some((order) => order !== ids(journey).join())).toBe(true);
	});

	it('reads no clock and no randomness', () => {
		const input = inputOf(SCENARIOS.journey());
		vi.spyOn(Math, 'random').mockImplementation(() => {
			throw new Error('Math.random was called');
		});
		vi.useFakeTimers({ now: new Date('2031-03-04T05:06:07Z') });
		const once = generateProgram(input, MONDAY);
		vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
		expect(generateProgram(input, MONDAY)).toEqual(once);
		expect(once).toEqual(scenario('journey').plan);
	});
});

describe('a ‘this_week’ start', () => {
	it.each(KEYS)(
		'%s: from Thursday plans Thursday to Sunday only, and the weeks after in full',
		(key) => {
			const { plan } = scenario(key, THURSDAY);
			expect(validate(programPlanSchema, plan)).toEqual({ ok: true, data: plan });
			expect(plan).toMatchObject(THURSDAY);
			const [week1, ...later] = weeksOf(plan);
			expect(week1!.sessions.length).toBeGreaterThan(0);
			for (const s of week1!.sessions) {
				expect(['thu', 'fri', 'sat', 'sun']).toContain(weekdayOf(s.date));
				expect(s.date >= THURSDAY.firstPlannedDay && s.date <= week1!.endsOn).toBe(true);
			}
			// From week 2 on, the same sessions on the same days as a Monday start.
			const shape = (weeks: readonly WeekPlan[]) =>
				weeks.map((w) => w.sessions.map((s) => [s.date, s.kind, s.type, s.title, s.source]));
			expect(shape(later)).toEqual(shape(weeksOf(scenario(key).plan).slice(1)));
		}
	);
});

/** The minimal profile with strength first over hard Muay Thai Mon/Wed/Fri: one 'avoid' is kept. */
function strengthOverClasses(): TrainingProfile {
	const p = SCENARIOS.minimal();
	const [base] = p.goals;
	p.goals = [
		base!,
		{
			...base!,
			id: '00000000-0000-4000-8000-000000000121',
			title: 'Fight',
			disciplines: ['muay_thai'],
			priority: 2
		}
	];
	p.schedule.daysPerWeek = 5;
	p.schedule.preferredTimes = ['evening'];
	p.schedule.commitments = [
		{
			id: '00000000-0000-4000-8000-000000000230',
			discipline: 'muay_thai',
			label: 'Muay Thai class',
			days: ['mon', 'wed', 'fri'],
			timeOfDay: 'evening',
			durationMinutes: 60,
			intensity: 'hard',
			notes: null
		}
	];
	return p;
}

describe('every plan’s rules and decisions', () => {
	const variant = (options: typeof MONDAY) =>
		generateProgram(inputOf(strengthOverClasses()), options);
	const cases: [string, (options: typeof MONDAY) => ProgramPlan][] = [
		...KEYS.map((key): [string, (options: typeof MONDAY) => ProgramPlan] => [
			key,
			(options) => scenario(key, options).plan
		]),
		['strength ranked over hard classes', variant]
	];

	it.each(cases)(
		'%s: checkWeek finds no ‘avoid’ that a priority decision does not explain',
		(name, planned) => {
			for (const options of [MONDAY, THURSDAY]) {
				const plan = planned(options);
				const paths = new Map(placedIn(plan).map((p) => [p.session, p.path]));
				const cited = new Set(
					plan.decisions.filter((d) => d.kind === 'priority_tradeoff').flatMap((d) => d.refs)
				);
				const avoid = avoidIn(plan);
				const unexplained = avoid.filter((v) => !v.sessions.some((s) => cited.has(paths.get(s)!)));
				expect(unexplained.map((v) => v.message)).toEqual([]);
				if (name === 'strength ranked over hard classes' && options === MONDAY) {
					expect(avoid.length).toBeGreaterThan(0);
				}
			}
		}
	);

	it.each(KEYS)('%s: every decision has a kind in DECISION_KINDS and a rationale', (key) => {
		for (const options of [MONDAY, THURSDAY]) {
			const { plan } = scenario(key, options);
			expect(plan.decisions.length).toBeGreaterThan(0);
			for (const d of plan.decisions) {
				expect(DECISION_KINDS).toContain(d.kind);
				expect(d.decidedBy).toBe('rules');
				expect(d.ruleKey).toMatch(/^[a-z_]+\.[a-z0-9_.]+$/);
				for (const words of [d.summary, d.why]) {
					expect(words.trim()).not.toBe('');
					expect(words).not.toMatch(/[{}]/);
				}
			}
		}
	});
});

describe('the program_purpose decision', () => {
	const purposeOf = (plan: ProgramPlan) =>
		plan.decisions.filter((d) => d.kind === 'program_purpose');

	it.each(KEYS)('%s: comes first, once, about week 1, toward every goal', (key) => {
		const { plan, input } = scenario(key);
		const [first] = plan.decisions;
		expect(purposeOf(plan)).toEqual([first]);
		expect(first).toMatchObject({
			ruleKey: 'program.baseline_week',
			summary: 'Week 1 establishes your baselines',
			refs: ['blocks.0.weeks.0'],
			decidedBy: 'rules'
		});
		expect(first!.why).toMatch(/^Nothing in it goes above RPE 7(, your commitments aside)?\. /);
		const goals = input.goals.map((g) => g.title);
		expect(first!.why).toMatch(/Every week after it builds on what you record, toward .+\.$/);
		for (const title of goals) expect(first!.why).toContain(title);
	});

	it('says what week 1 does for each kind of lift and run', () => {
		const why = (key: ScenarioKey) => purposeOf(scenario(key).plan)[0]!.why;
		expect(why('beginner')).toBe(
			'Nothing in it goes above RPE 7. Each main lift works up to a top set by RPE, which estimates its 1RM. Every week after it builds on what you record, toward Get strong.'
		);
		expect(why('powerlifter')).toBe(
			'Nothing in it goes above RPE 7. Each main lift starts at a safe share of your 1RM for it. Every week after it builds on what you record, toward Meet.'
		);
		expect(why('hybrid')).toBe(
			'Nothing in it goes above RPE 7, your commitments aside. Lifts with a 1RM start at a safe share of it; the rest work up to a top set by RPE. Runs start from the volume you run now. Every week after it builds on what you record, toward Marathon, Stay strong and Muay Thai.'
		);
		expect(why('journey')).toBe(
			'Nothing in it goes above RPE 7. Each main lift works up to a top set by RPE, which estimates its 1RM. Runs go by time and effort. Every week after it builds on what you record, toward Fight, Marathon and Keep strength.'
		);
		expect(purposeOf(scenario('journey').plan)[0]!.evidence).toEqual({
			purpose:
				'Nothing in it goes above RPE 7. Each main lift works up to a top set by RPE, which estimates its 1RM. Runs go by time and effort.',
			goal: 'Fight, Marathon and Keep strength',
			rpeCap: 7,
			firstPlannedDay: SCENARIO_START
		});
	});

	/** The hardest RPE `session` asks for: its own, or a set's, a segment's or its details'. */
	const hardest = (session: SessionPlan) =>
		Math.max(
			session.targetRpe,
			...(session.kind === 'strength'
				? session.exercises.flatMap((e) => e.sets.map((line) => line.targetRpe ?? 0))
				: session.kind === 'run'
					? session.segments.map((segment) => segment.targetRpe ?? 0)
					: [session.details.targetRpe ?? 0])
		);

	it.each(KEYS)(
		'%s: nothing in week 1 goes above the RPE it names but a commitment it sets aside',
		(key) => {
			const { plan } = scenario(key);
			const { rpeCap, purpose } = purposeOf(plan)[0]!.evidence;
			const aside = String(purpose).includes('your commitments aside');
			const above = weeksOf(plan)[0]!.sessions.filter((s) => hardest(s) > Number(rpeCap));
			expect(above.filter((s) => !aside || s.source !== 'commitment')).toEqual([]);
			expect(above.length > 0).toBe(aside);
		}
	);

	it('says when week 1 starts mid-week, and fits the decision’s limits at its longest', () => {
		const wednesday = { ...MONDAY, firstPlannedDay: scenarioDay(1, 2) };
		const plan = generateProgram(inputOf(SCENARIOS.hybrid()), wednesday);
		const [purpose] = purposeOf(plan);
		expect(purpose!.evidence.purpose).toBe(
			'It plans Wednesday to Sunday, at RPE 7 at most, your commitments aside. Lifts with a 1RM start at a safe share of it; the rest work up to a top set by RPE. Runs start from the volume you run now.'
		);
		expect(String(purpose!.evidence.purpose).length).toBeLessThanOrEqual(200);
		const sunday = { ...MONDAY, firstPlannedDay: scenarioDay(1, 6) };
		expect(purposeOf(generateProgram(inputOf(SCENARIOS.minimal()), sunday))[0]!.why).toMatch(
			/^It plans Sunday only, at RPE 7 at most\. /
		);
	});

	it('names the paused goals a maintenance program keeps, and no goal when none is open', () => {
		const p = SCENARIOS.minimal();
		p.goals[0]!.status = 'paused';
		const plan = generateProgram(inputOf(p), MONDAY);
		expect(purposeOf(plan)[0]!.why).toMatch(/toward Get stronger, at maintenance\.$/);
		p.goals[0]!.status = 'achieved';
		expect(purposeOf(generateProgram(inputOf(p), MONDAY))[0]!.evidence.goal).toBe('your training');
	});

	it('speaks only of the runs it plans, not a running club’s', () => {
		const p = SCENARIOS.minimal();
		p.schedule.commitments = [
			{
				id: '00000000-0000-4000-8000-000000000240',
				discipline: 'running',
				label: 'Running club',
				days: ['tue'],
				timeOfDay: 'evening',
				durationMinutes: 45,
				intensity: 'light',
				notes: null
			}
		];
		const plan = generateProgram(inputOf(p), MONDAY);
		expect(weeksOf(plan)[0]!.sessions.filter((s) => s.kind === 'run')).toEqual([
			expect.objectContaining({ source: 'commitment', title: 'Running club' })
		]);
		expect(purposeOf(plan)[0]!.evidence.purpose).toBe(
			'Nothing in it goes above RPE 7. Each main lift works up to a top set by RPE, which estimates its 1RM.'
		);
	});

	it('clips a long list of goals to the decision’s limit', () => {
		const p = SCENARIOS.journey();
		p.goals = p.goals.map((g, i) => ({ ...g, title: `${'A long goal title '.repeat(4)}${i}` }));
		const [purpose] = purposeOf(generateProgram(inputOf(p), MONDAY));
		const goal = String(purpose!.evidence.goal);
		expect(goal).toHaveLength(200);
		expect(goal).toMatch(/^A long goal title .+…$/);
		expect(purpose!.why).toContain(`toward ${goal}.`);
	});
});
