/**
 * placement.ts, through generateProgram: the hybrid scenario (strength + a dated marathon + hard
 * Muay Thai Tue/Thu evenings, 5 days of 75 min) with its commitments first, its long run at the
 * weekend and its priority decisions; times of day and the order in a day; the day rule; a hard
 * class kept clear of intervals; an over-constrained week dropping, or by priority keeping, a
 * session; decisions that follow the sessions; every scenario deterministic and rule-clean.
 */
import { describe, expect, it } from 'vitest';
import { weekdayOf } from '../calendar';
import { CATALOGUE } from '../exercises/index';
import type { Weekday } from '../profile/catalog';
import type { Commitment, Goal, TrainingProfile } from '../profile/types';
import { programPlanSchema } from '../training/schemas';
import type { ProgramPlan, SessionPlan } from '../training/types';
import { validate } from '../validation';
import { weekBudget } from './demand';
import { generateProgram } from './generate';
import { buildProgrammingInput } from './input';
import { checkWeek, demandOf } from './interference';
import { SCENARIO_START, SCENARIOS, scenarioDay } from './scenarios';
import type { ScenarioKey } from './scenarios';

const OPTIONS = { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START };
const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });
const generate = (profile: TrainingProfile, options = OPTIONS) =>
	generateProgram(inputOf(profile), options);

const weeksOf = (plan: ProgramPlan) => plan.blocks.flatMap((b) => b.weeks);
const day = (s: SessionPlan) => weekdayOf(s.date);
const at = (plan: ProgramPlan, path: string) => {
	const [, b, , w, , s] = path.split('.').map(Number);
	return plan.blocks[b!]!.weeks[w!]!.sessions[s!]!;
};
/** Every rule the plan's sessions break, across the weeks as well as within them. */
const rulesIn = (plan: ProgramPlan) => checkWeek(weeksOf(plan).flatMap((w) => w.sessions));
const avoidIn = (plan: ProgramPlan) => rulesIn(plan).filter((v) => v.severity === 'avoid');

const commitment = (over: Partial<Commitment>): Commitment => ({
	id: '00000000-0000-4000-8000-000000000230',
	discipline: 'muay_thai',
	label: 'Muay Thai class',
	days: ['tue'],
	timeOfDay: 'evening',
	durationMinutes: 60,
	intensity: 'moderate',
	notes: null,
	...over
});

/** The minimal profile with these goals, by priority, and this schedule. */
function variant(
	goals: Pick<Goal, 'title' | 'disciplines'>[],
	schedule: Partial<TrainingProfile['schedule']>
): TrainingProfile {
	const p = SCENARIOS.minimal();
	const [base] = p.goals;
	p.goals = goals.map((g, i) => ({
		...base!,
		...g,
		id: `00000000-0000-4000-8000-00000000012${i}`,
		priority: i + 1
	}));
	p.schedule = { ...p.schedule, ...schedule };
	return p;
}

describe('the hybrid scenario', () => {
	const profile = SCENARIOS.hybrid();
	const plan = generate(profile);
	const weeks = weeksOf(plan);

	it('places the Muay Thai classes first, on Tuesday and Thursday evenings every week', () => {
		expect(weeks).toHaveLength(5);
		for (const week of weeks) {
			const classes = week.sessions.filter((s) => s.source === 'commitment');
			expect(classes.map((s) => [day(s), s.timeOfDay])).toEqual([
				['tue', 'evening'],
				['thu', 'evening']
			]);
		}
	});

	it('breaks no avoid rule, within a week or across one, nor puts intervals after a very demanding day', () => {
		expect(avoidIn(plan)).toEqual([]);
		expect(rulesIn(plan).map((v) => v.rule)).not.toContain('intervals_after_very_demanding');
	});

	it('puts the long run on Saturday, with no heavy lower body the day before', () => {
		for (const week of weeks) {
			const long = week.sessions.filter((s) => demandOf(s).longRun);
			expect(long.map(day)).toEqual(['sat']);
			const friday = week.sessions.filter((s) => day(s) === 'fri');
			expect(friday.filter((s) => demandOf(s).heavyLower)).toEqual([]);
		}
	});

	it('lifts on the class mornings every week, the lighter ones included, before the class', () => {
		for (const week of weeks) {
			const lifting = week.sessions.filter((s) => s.kind === 'strength');
			expect(lifting.map((s) => [day(s), s.timeOfDay, s.orderInDay])).toEqual([
				['tue', 'morning', 1],
				['thu', 'morning', 1]
			]);
			for (const s of week.sessions.filter((s) => s.source === 'commitment')) {
				expect(s.orderInDay).toBe(2);
			}
		}
		expect(weeks.map((w) => w.kind)).toEqual([
			'baseline',
			'accumulation',
			'accumulation',
			'accumulation',
			'deload'
		]);
	});

	it('trains on 5 days, each generated session at a preferred time, in date order', () => {
		for (const week of weeks) {
			expect(new Set(week.sessions.map((s) => s.date)).size).toBe(5);
			for (const s of week.sessions.filter((s) => s.source === 'generator')) {
				expect(['morning', 'evening']).toContain(s.timeOfDay);
			}
			const order = week.sessions.map((s) => `${s.date} ${s.orderInDay}`);
			expect(order).toEqual([...order].sort());
		}
	});

	it('explains the conflicts: the classes, and the marathon ranked above strength', () => {
		const resolved = plan.decisions.filter((d) => d.kind === 'interference_resolved');
		expect(resolved.map((d) => d.summary)).toEqual([
			'Strength A kept clear of Muay Thai class',
			'Strength B kept clear of Muay Thai class'
		]);
		expect(resolved[0]!.why).toBe(
			'Heavy lower body the day before hard Muay Thai: Strength A on Monday, then Muay Thai class on Tuesday, so Strength A goes on Tuesday morning instead.'
		);
		const priority = plan.decisions.filter(
			(d) => d.kind === 'priority_tradeoff' && d.ruleKey === 'placement.priority'
		);
		expect(priority).toHaveLength(1);
		expect(priority[0]).toMatchObject({
			summary: 'Marathon over Stay strong',
			why: 'Marathon ranks above Stay strong, so its Long run keeps Saturday morning, and Stay strong is planned around it: heavy lower body the day before a long run is avoided.'
		});
		const cited = priority[0]!.refs.map((ref) => at(plan, ref));
		expect(cited).toHaveLength(10);
		expect(new Set(cited.map((s) => `${s.kind} ${day(s)}`))).toEqual(
			new Set(['strength tue', 'strength thu'])
		);
	});

	it('is rule-clean in the journey scenario too: a fight, a marathon and strength', () => {
		const journey = generate(SCENARIOS.journey());
		expect(avoidIn(journey)).toEqual([]);
		const long = weeksOf(journey).flatMap((w) => w.sessions.filter((s) => demandOf(s).longRun));
		expect(long.length).toBeGreaterThan(0);
		expect(new Set(long.map(day))).toEqual(new Set(['sat']));
		for (const week of weeksOf(journey)) {
			expect(week.sessions.filter((s) => s.source === 'commitment').map(day)).toEqual([
				'tue',
				'thu'
			]);
		}
	});
});

describe('placement', () => {
	it('gives a morning easy run and an evening class on one day those times, in that order', () => {
		const p = variant([{ title: 'Run more', disciplines: ['running'] }], {
			daysPerWeek: 2,
			availableDays: ['wed', 'sat'],
			preferredTimes: ['morning', 'evening'],
			commitments: [commitment({ days: ['wed'] })]
		});
		for (const week of weeksOf(generate(p))) {
			const wednesday = week.sessions.filter((s) => day(s) === 'wed');
			expect(wednesday.map((s) => [s.type, s.timeOfDay, s.orderInDay])).toEqual([
				['easy_run', 'morning', 1],
				['muay_thai', 'evening', 2]
			]);
			expect(week.sessions.filter((s) => day(s) === 'sat').map((s) => s.timeOfDay)).toEqual([
				'morning'
			]);
		}
	});

	it.each(Object.keys(SCENARIOS) as ScenarioKey[])(
		'%s: trains on no more days than the week has, all of them days open to training',
		(key) => {
			const input = inputOf(SCENARIOS[key]());
			const budget = weekBudget(input);
			for (const week of weeksOf(generateProgram(input, OPTIONS))) {
				const dates = new Set(week.sessions.map((s) => s.date));
				expect(dates.size).toBeLessThanOrEqual(
					Math.max(budget.trainingDays, budget.commitmentDays)
				);
				for (const date of dates) expect(budget.days).toContain(weekdayOf(date));
				const free = week.sessions.filter(
					(s) => s.source === 'generator' && !budget.commitmentWeekdays.includes(day(s))
				);
				expect(new Set(free.map((s) => s.date)).size).toBe(free.length);
				expect(free.length).toBeLessThanOrEqual(budget.freeDays);
			}
		}
	);

	it('places generated hard Muay Thai before the heavy lower days, so a clean week is found', () => {
		const p = SCENARIOS.journey();
		p.goals = [p.goals[0]!, { ...p.goals[2]!, priority: 2 }];
		p.schedule = { ...p.schedule, daysPerWeek: 6, commitments: [] };
		const updatedAt = p.profile.updatedAt;
		p.muayThai = { sessionsPerWeek: 3, sparringPerWeek: 1, fights: 0, notes: null, updatedAt };
		const plan = generate(p);
		const combat = weeksOf(plan).map((w) => w.sessions.filter((s) => demandOf(s).hardCombat));
		expect(combat.map((sessions) => sessions.length)).toEqual([1, 2, 2, 2, 1]);
		expect(avoidIn(plan)).toEqual([]);
		for (const week of weeksOf(plan)) {
			expect(week.sessions.filter((s) => s.kind === 'strength')).toHaveLength(3);
		}
		expect(plan.decisions.filter((d) => d.ruleKey.startsWith('placement.'))).toEqual([
			expect.objectContaining({
				ruleKey: 'placement.priority',
				summary: 'Fight over Keep strength'
			})
		]);
	});

	it('keeps the long run at the weekend after a hard Friday class, though the days are both hard', () => {
		const p = SCENARIOS.hybrid();
		const [classes] = p.schedule.commitments;
		p.schedule = { ...p.schedule, commitments: [{ ...classes!, days: ['fri'] }] };
		const plan = generate(p);
		for (const week of weeksOf(plan)) {
			expect(week.sessions.filter((s) => demandOf(s).longRun).map(day)).toEqual(['sat']);
		}
		expect(avoidIn(plan)).toEqual([]);
	});

	it('keeps intervals off the day after a hard strength class, and says why', () => {
		const p = variant([{ title: 'Run faster', disciplines: ['running'] }], {
			daysPerWeek: 5,
			availableDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
			commitments: [
				commitment({
					discipline: 'strength',
					label: 'CrossFit class',
					days: ['mon', 'wed'],
					intensity: 'hard'
				})
			]
		});
		p.experience = SCENARIOS.hybrid().experience.map((e) => ({ ...e, discipline: 'running' }));
		p.running = SCENARIOS.hybrid().running;
		const plan = generate(p);
		const intervals = weeksOf(plan).flatMap((w) =>
			w.sessions.filter((s) => s.type === 'interval_run')
		);
		expect(intervals.length).toBeGreaterThan(0);
		for (const s of intervals) expect(['tue', 'thu']).not.toContain(day(s));
		expect(avoidIn(plan)).toEqual([]);
		const resolved = plan.decisions.find((d) => d.kind === 'interference_resolved');
		expect(resolved).toMatchObject({
			ruleKey: 'placement.intervals_after_very_demanding',
			summary: 'Intervals kept clear of CrossFit class'
		});
		expect(resolved!.refs.map((ref) => at(plan, ref).type)).toEqual(
			resolved!.refs.map(() => 'interval_run')
		);
	});

	describe('an over-constrained week', () => {
		/** Hard Muay Thai Mon/Wed/Fri, 5 days, one preferred time: two free days, no doubles. */
		const fightAndStrength = (fightFirst: boolean) => {
			const fight = { title: 'Fight', disciplines: ['muay_thai' as const] };
			const strong = { title: 'Get stronger', disciplines: ['strength' as const] };
			return variant(fightFirst ? [fight, strong] : [strong, fight], {
				daysPerWeek: 5,
				preferredTimes: ['evening'],
				commitments: [commitment({ days: ['mon', 'wed', 'fri'], intensity: 'hard' })]
			});
		};

		it('drops the lowest-priority session that every day left would break a rule for', () => {
			const plan = generate(fightAndStrength(true));
			expect(plan.decisions.filter((d) => d.kind === 'session_dropped')).toEqual([
				expect.objectContaining({
					ruleKey: 'placement.every_day_clashes',
					summary: 'Strength B left out this week',
					why: 'The week has no room for Strength B: every day left breaks a rule, such as heavy lower body the day before hard Muay Thai: Strength B on Tuesday, then Muay Thai class on Wednesday. Lower-priority sessions give way first.',
					refs: weeksOf(plan).map((_, w) => `blocks.0.weeks.${w}`)
				})
			]);
			// Saturday is the one free day not before a class: a Sunday is before next Monday's.
			for (const week of weeksOf(plan)) {
				const lifting = week.sessions.filter((s) => s.kind === 'strength');
				expect(lifting.map((s) => [s.title, day(s)])).toEqual([['Strength A', 'sat']]);
			}
			expect(avoidIn(plan)).toEqual([]);
		});

		it('keeps it, with a priority decision for each rule it breaks, when its goal ranks first', () => {
			const plan = generate(fightAndStrength(false));
			expect(plan.decisions.filter((d) => d.kind === 'session_dropped')).toEqual([]);
			const kept = plan.decisions.filter((d) => d.ruleKey === 'placement.priority_kept');
			expect(kept.map((d) => [d.summary, d.why])).toEqual([
				[
					'Get stronger over Fight',
					'Get stronger ranks above Fight, so Full body B keeps Tuesday evening, the best day left. Heavy lower body the day before hard Muay Thai: Full body B on Tuesday, then Muay Thai class on Wednesday.'
				]
			]);
			for (const week of weeksOf(plan)) {
				const lifting = week.sessions.filter((s) => s.kind === 'strength');
				expect(lifting.map((s) => [s.title, day(s)])).toEqual([
					['Full body B', 'tue'],
					['Full body A', 'sat']
				]);
			}
			// Only the building weeks break it: the baseline and the deload lift too lightly to.
			const rules = avoidIn(plan);
			const cited = kept[0]!.refs;
			expect(cited).toEqual([1, 2, 3].map((w) => `blocks.0.weeks.${w}.sessions.1`));
			expect(rules.map((v) => v.sessions[0])).toEqual(cited.map((ref) => at(plan, ref)));
		});

		it('keeps it on a day that clashes only with a lower goal, though its best day clashes with a higher one', () => {
			// Fight, then strength, then the marathon; hard classes Tue/Thu evenings; one preferred
			// time, the classes' own, so no class day can take a second session.
			const p = SCENARIOS.journey();
			const [fight, marathon, strength] = p.goals;
			p.goals = [fight!, { ...strength!, priority: 2 }, { ...marathon!, priority: 3 }];
			const [classes] = p.schedule.commitments;
			p.schedule = {
				...p.schedule,
				daysPerWeek: 6,
				preferredTimes: ['evening'],
				commitments: [{ ...classes!, intensity: 'hard' }]
			};
			const plan = generate(p);
			for (const week of weeksOf(plan)) {
				const lifting = week.sessions.filter((s) => s.kind === 'strength');
				expect(lifting.map((s) => [s.title, day(s)])).toEqual([['Strength A', 'fri']]);
			}
			expect(
				plan.decisions.filter((d) => d.ruleKey.startsWith('placement.')).map((d) => d.summary)
			).toEqual([
				'Strength A kept clear of Muay Thai class',
				'Keep strength over Marathon',
				'Strength B left out this week'
			]);
		});

		it('drops the lowest-priority sessions a part week 1 has no room for', () => {
			const plan = generate(SCENARIOS.hybrid(), { ...OPTIONS, firstPlannedDay: scenarioDay(1, 3) });
			const [first] = weeksOf(plan);
			expect(first!.sessions.map((s) => [day(s), s.type, s.timeOfDay])).toEqual([
				['thu', 'easy_run', 'morning'],
				['thu', 'muay_thai', 'evening'],
				['fri', 'tempo_run', 'morning'],
				['sat', 'long_run', 'morning']
			]);
			expect(plan.decisions.filter((d) => d.kind === 'session_dropped')).toEqual([
				expect.objectContaining({
					ruleKey: 'placement.no_room',
					summary: 'Strength B left out this week',
					why: 'The week has no room for Strength B: the days left this week hold 3 sessions besides your commitments. Lower-priority sessions give way first.',
					refs: ['blocks.0.weeks.0']
				})
			]);
		});
	});

	it('moves every decision’s refs with the sessions it is about', () => {
		for (const options of [OPTIONS, { ...OPTIONS, firstPlannedDay: scenarioDay(1, 3) }]) {
			const plan = generate(SCENARIOS.hybrid(), options);
			const cited = (kind: string) =>
				plan.decisions
					.filter((d) => d.kind === kind)
					.flatMap((d) => d.refs.map((r) => at(plan, r)));
			expect(cited('commitment_placed').map((s) => s.source)).toEqual(
				Array(cited('commitment_placed').length).fill('commitment')
			);
			expect(cited('commitment_placed')).toHaveLength(options === OPTIONS ? 10 : 9);
			expect(new Set(cited('quality_session').map((s) => s.type))).toEqual(new Set(['tempo_run']));
			expect(validate(programPlanSchema, plan).ok).toBe(true);
		}
	});

	it.each(Object.keys(SCENARIOS) as ScenarioKey[])(
		'%s: re-runs to the same plan, valid and breaking no avoid rule, in date order',
		(key) => {
			const plan = generate(SCENARIOS[key]());
			expect(JSON.stringify(generate(SCENARIOS[key]()))).toBe(JSON.stringify(plan));
			expect(validate(programPlanSchema, plan)).toEqual({ ok: true, data: plan });
			expect(avoidIn(plan)).toEqual([]);
			for (const week of weeksOf(plan)) {
				const order = week.sessions.map((s) => `${s.date} ${s.orderInDay}`);
				expect(order).toEqual([...order].sort());
			}
		}
	);

	it('keeps to the available days when they leave fewer than the week asks for', () => {
		const p = variant([{ title: 'Get stronger', disciplines: ['strength'] }], {
			daysPerWeek: 4,
			availableDays: ['tue', 'thu', 'sat'] satisfies Weekday[]
		});
		for (const week of weeksOf(generate(p))) {
			expect(week.sessions.map(day)).toEqual(['tue', 'thu', 'sat']);
		}
	});
});

describe('a fighter who also lifts and runs, with classes five days a week and no set time', () => {
	// One goal across lifting, running and Muay Thai; classes on five days, most with a set time;
	// 'it varies' as the preferred time, so the free days alone cannot hold the lifts and runs.
	const fighter = () =>
		variant([{ title: 'Fitter', disciplines: ['strength', 'running', 'muay_thai'] }], {
			daysPerWeek: 7,
			availableDays: [],
			preferredTimes: ['varies'],
			sessionMinutes: 60,
			commitments: [
				commitment({ label: 'Drilling', days: ['mon'], intensity: 'light' }),
				commitment({
					id: '00000000-0000-4000-8000-000000000231',
					label: 'Pads and Clinch',
					days: ['tue', 'thu'],
					durationMinutes: 120,
					intensity: 'hard'
				}),
				commitment({
					id: '00000000-0000-4000-8000-000000000232',
					label: 'Comp Team Sparring',
					days: ['wed'],
					timeOfDay: null,
					durationMinutes: 90,
					intensity: 'hard'
				}),
				commitment({
					id: '00000000-0000-4000-8000-000000000233',
					label: 'Sparring',
					days: ['sat'],
					timeOfDay: 'morning'
				})
			]
		});

	it('adds its lifts and runs as morning sessions beside evening classes', () => {
		expect(weekBudget(inputOf(fighter())).doubleDays).toEqual(['mon', 'tue', 'thu', 'sat']);
		const plan = generate(fighter());
		expect(validate(programPlanSchema, plan).ok).toBe(true);
		expect(plan.decisions.filter((d) => d.kind === 'session_dropped')).toEqual([]);
		const building = weeksOf(plan).find((w) => w.kind === 'accumulation')!;
		const generated = building.sessions.filter((s) => s.source === 'generator');
		expect(generated.filter((s) => s.kind === 'strength').length).toBeGreaterThanOrEqual(2);
		expect(generated.filter((s) => s.discipline === 'running').length).toBeGreaterThanOrEqual(2);
		for (const s of generated) {
			const beside = building.sessions.filter(
				(o) => o.source === 'commitment' && o.date === s.date
			);
			// Never beside the class with no set time, and never at the class's own time.
			expect(beside.map((o) => o.title)).not.toContain('Comp Team Sparring');
			if (beside.length > 0) {
				expect(s.timeOfDay).not.toBeNull();
				expect(s.timeOfDay).not.toBe(beside[0]!.timeOfDay);
			}
		}
	});
});
