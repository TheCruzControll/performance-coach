/**
 * The strength stage, through generateProgram: the brief's dumbbells-only, injured-shoulder and
 * powerlifter scenarios; as many strength sessions as the day rule gives; naive spacing until
 * placement; each week at its own RPE cap.
 */
import { describe, expect, it } from 'vitest';
import { weekdayOf } from '../../calendar';
import { CATALOGUE, catalogueByKey } from '../../exercises/index';
import type { Weekday } from '../../profile/catalog';
import type { TrainingProfile } from '../../profile/types';
import type { ProgramPlan, StrengthSessionPlan } from '../../training/types';
import { DecisionLog } from '../decisions';
import { allocateWeek, generatedFor, weekBudget } from '../demand';
import { generateProgram } from '../generate';
import { buildProgrammingInput } from '../input';
import { SCENARIO_START, SCENARIOS, scenarioDay } from '../scenarios';
import { naiveDays, strength } from './strength';

const OPTIONS = { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START };
const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });
const generate = (profile: TrainingProfile, options = OPTIONS) =>
	generateProgram(inputOf(profile), options);

const weeksOf = (plan: ProgramPlan) => plan.blocks.flatMap((b) => b.weeks);
const strengthIn = (sessions: ProgramPlan['blocks'][number]['weeks'][number]['sessions']) =>
	sessions.filter((s): s is StrengthSessionPlan => s.kind === 'strength');
const exercisesIn = (plan: ProgramPlan) =>
	weeksOf(plan).flatMap((w) =>
		strengthIn(w.sessions).flatMap((s) =>
			s.exercises.map((e) => catalogueByKey.get('key' in e.exercise ? e.exercise.key : '')!)
		)
	);

describe('the brief’s scenarios', () => {
	it('dumbbells only: only dumbbell, bench and bodyweight work, and squat, hinge, push and pull every week', () => {
		const plan = generate(SCENARIOS.dumbbellsOnly());
		for (const e of exercisesIn(plan)) {
			expect(e.equipment.every((item) => item === 'dumbbells' || item === 'bench')).toBe(true);
		}
		for (const week of weeksOf(plan)) {
			const patterns = strengthIn(week.sessions).flatMap((s) =>
				s.exercises.map(
					(e) => catalogueByKey.get('key' in e.exercise ? e.exercise.key : '')!.pattern
				)
			);
			for (const wanted of [
				['squat'],
				['hinge'],
				['horizontal_push', 'vertical_push'],
				['horizontal_pull', 'vertical_pull']
			]) {
				expect(patterns.some((p) => wanted.includes(p))).toBe(true);
			}
		}
	});

	it('injured shoulder: nothing overhead in any week, vertical pushing only by landmine, with a decision', () => {
		const plan = generate(SCENARIOS.injuredShoulder());
		const exercises = exercisesIn(plan);
		expect(exercises.filter((e) => e.tags.includes('overhead'))).toEqual([]);
		const pressing = exercises.filter((e) => e.pattern === 'vertical_push');
		expect(pressing.length).toBeGreaterThan(0);
		expect(new Set(pressing.map((e) => e.substitutionGroup))).toEqual(
			new Set(['vertical_press_shoulder_friendly'])
		);
		const press = plan.decisions.find(
			(d) => d.kind === 'exercise_substituted' && d.evidence.original === 'Overhead press'
		);
		expect(press?.why).toContain('your moderate left shoulder injury rules out overhead work');
	});

	it('powerlifter: back squat, bench press and deadlift are the main lifts every week', () => {
		const plan = generate(SCENARIOS.powerlifter());
		for (const week of weeksOf(plan)) {
			const mains = strengthIn(week.sessions).flatMap((s) =>
				s.exercises
					.filter((e) => e.sets.some((l) => l.role === 'top'))
					.map((e) => ('key' in e.exercise ? e.exercise.key : ''))
			);
			expect(mains).toEqual(['back_squat', 'bench_press', 'deadlift', 'bench_press']);
		}
		expect(plan.decisions.find((d) => d.kind === 'split_chosen')?.summary).toBe(
			'Split: squat, bench and deadlift, 4 days a week'
		);
	});
});

describe('the strength stage', () => {
	/** The minimal profile on `days` days a week, Monday to Saturday. */
	function minimal(days: number, commitmentDays: Weekday[] = []) {
		const p = SCENARIOS.minimal();
		p.schedule.daysPerWeek = days;
		p.schedule.availableDays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
		if (commitmentDays.length) {
			p.schedule.commitments = [
				{
					id: '00000000-0000-4000-8000-000000000210',
					discipline: 'strength',
					label: 'Strength class',
					days: commitmentDays,
					timeOfDay: null,
					durationMinutes: 60,
					intensity: 'hard',
					notes: null
				}
			];
		}
		return p;
	}

	it.each([2, 3, 4])('plans the %i strength sessions the day rule gives, every week', (days) => {
		const p = minimal(days);
		const input = inputOf(p);
		const given = generatedFor(
			allocateWeek(input, weekBudget(input), new DecisionLog()),
			'strength'
		);
		expect(given).toBe(days);
		for (const week of weeksOf(generate(p))) expect(strengthIn(week.sessions)).toHaveLength(days);
	});

	it('plans fewer when strength classes take some of the days, and says so', () => {
		const plan = generate(minimal(4, ['tue', 'thu']));
		for (const week of weeksOf(plan)) {
			const sessions = strengthIn(week.sessions);
			expect(sessions).toHaveLength(2);
			expect(sessions.map((s) => weekdayOf(s.date))).toEqual(['mon', 'fri']);
		}
		const split = plan.decisions.find((d) => d.kind === 'split_chosen')!;
		expect(split.why).toBe(
			'With 2 strength days a week besides your 2 strength classes, a full-body split trains every main movement each session, so each is practised several times a week.'
		);
		expect(split.refs).toEqual(['blocks.0']);
	});

	it('spaces the days evenly over the free days, then the commitment days, until placement', () => {
		const budget = (days: Weekday[], commitmentWeekdays: Weekday[]) => ({
			...weekBudget(inputOf(SCENARIOS.minimal())),
			days,
			commitmentWeekdays
		});
		const week: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
		expect(naiveDays(budget(week, []), 3)).toEqual(['mon', 'wed', 'fri']);
		expect(naiveDays(budget(week, ['tue', 'thu']), 2)).toEqual(['mon', 'fri']);
		expect(naiveDays(budget(['mon', 'tue', 'wed'], ['tue']), 3)).toEqual(['mon', 'wed', 'tue']);

		const plan = generate(SCENARIOS.beginner());
		expect(strengthIn(weeksOf(plan)[0]!.sessions).map((s) => [s.date, s.timeOfDay])).toEqual([
			[scenarioDay(1, 0), 'evening'],
			[scenarioDay(1, 2), 'evening'],
			[scenarioDay(1, 4), 'evening']
		]);
	});

	it('takes the next place in a day that already holds a session, at another preferred time', () => {
		const p = minimal(3);
		p.schedule.availableDays = ['mon'];
		p.schedule.preferredTimes = ['morning', 'evening'];
		p.schedule.commitments = [
			{
				id: '00000000-0000-4000-8000-000000000211',
				discipline: 'muay_thai',
				label: 'Muay Thai class',
				days: ['tue'],
				timeOfDay: 'morning',
				durationMinutes: 60,
				intensity: 'hard',
				notes: null
			}
		];
		const input = inputOf(p);
		const log = new DecisionLog();
		const budget = weekBudget(input);
		const demand = { budget, allocation: allocateWeek(input, budget, log) };
		expect(generatedFor(demand.allocation, 'strength')).toBe(2);
		const plan = generate(p);
		const week = plan.blocks[0]!.weeks[0]!;
		const classOnTuesday = {
			...strengthIn(week.sessions)[0]!,
			date: scenarioDay(1, 1),
			timeOfDay: 'morning' as const,
			title: 'Muay Thai class'
		};
		const draft = {
			demand,
			blocks: [{ ...plan.blocks[0]!, weeks: [{ ...week, sessions: [classOnTuesday] }] }]
		};
		const added = strength(draft, { input, options: OPTIONS, log }).blocks[0]!.weeks[0]!.sessions;
		expect(added.slice(1).map((s) => [s.date, s.orderInDay, s.timeOfDay])).toEqual([
			[scenarioDay(1, 0), 1, 'morning'],
			[scenarioDay(1, 1), 2, 'evening']
		]);
	});

	it('plans nothing before week 1’s first planned day', () => {
		const thursday = scenarioDay(1, 3);
		const [first, second] = weeksOf(
			generate(SCENARIOS.beginner(), { ...OPTIONS, firstPlannedDay: thursday })
		);
		expect(strengthIn(first!.sessions).map((s) => s.date)).toEqual([scenarioDay(1, 4)]);
		expect(strengthIn(second!.sessions)).toHaveLength(3);
	});

	it('keeps the exercises through the block, each week at its own RPE cap', () => {
		const weeks = weeksOf(generate(SCENARIOS.beginner()));
		const exercises = (w: (typeof weeks)[number]) =>
			strengthIn(w.sessions).map((s) => s.exercises.map((e) => e.exercise));
		for (const week of weeks) {
			expect(exercises(week)).toEqual(exercises(weeks[0]!));
			for (const s of strengthIn(week.sessions)) {
				expect(s.targetRpe).toBe(week.targets.rpeCap);
				const top = s.exercises[0]!.sets.find((l) => l.role === 'top');
				expect(top?.targetRpe).toBe(week.targets.rpeCap);
			}
		}
		const [baseline, , , , deload] = weeks.map((w) => strengthIn(w.sessions)[0]!);
		expect([baseline!.intensity, deload!.intensity]).toEqual(['moderate', 'easy']);
		expect(baseline).toMatchObject({ source: 'generator', commitmentRef: null, type: 'strength' });
	});

	it('leaves the draft as it is when no goal asks for strength', () => {
		const p = SCENARIOS.minimal();
		p.goals[0]!.disciplines = ['running'];
		const input = inputOf(p);
		const log = new DecisionLog();
		const budget = weekBudget(input);
		const draft = { demand: { budget, allocation: allocateWeek(input, budget, log) }, blocks: [] };
		const before = log.list().length;
		expect(strength(draft, { input, options: OPTIONS, log })).toBe(draft);
		expect(log.list()).toHaveLength(before);
	});
});
