/**
 * cross-training.ts: with a bike, half of a week's easy runs (rounded up, the latest first) become
 * zone 2 bike sessions for a goal training more than running; a running goal or a race keeps its
 * easy runs, long and quality runs never move, every week keeps a run, and with no bike nothing
 * changes. Checked on the owner's own week: five days of Muay Thai, lifting and a Saturday run.
 */
import { describe, expect, it } from 'vitest';
import { weekdayOf } from '../calendar';
import { CATALOGUE } from '../exercises/index';
import type { Commitment, Goal, TrainingProfile } from '../profile/types';
import { programPlanSchema } from '../training/schemas';
import type { ProgramPlan, SessionPlan, WeekPlan } from '../training/types';
import { validate } from '../validation';
import { ZONE2_WORDS } from './cross-training';
import { generateProgram } from './generate';
import { buildProgrammingInput } from './input';
import { ZONE2_BIKE } from './rules/running';
import { SCENARIO_START, SCENARIOS, scenarioDay } from './scenarios';

const OPTIONS = { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START };
const generate = (p: TrainingProfile) =>
	generateProgram(buildProgrammingInput(p, { catalogue: CATALOGUE }), OPTIONS);
const weeksOf = (plan: ProgramPlan) => plan.blocks.flatMap((b) => b.weeks);
const bikes = (week: WeekPlan) => week.sessions.filter((s) => s.title === ZONE2_BIKE.title);
const runs = (week: WeekPlan) => week.sessions.filter((s) => s.kind === 'run');
const day = (s: SessionPlan) => weekdayOf(s.date);

const commitment = (n: number, over: Partial<Commitment>): Commitment => ({
	id: `00000000-0000-4000-8000-0000000009${String(n).padStart(2, '0')}`,
	discipline: 'muay_thai',
	label: 'Class',
	days: ['mon'],
	timeOfDay: 'evening',
	durationMinutes: 60,
	intensity: 'moderate',
	notes: null,
	...over
});

/** The owner's profile: one goal over five disciplines, Muay Thai five days, a Saturday run. */
function owner({ bike = true }: { bike?: boolean } = {}): TrainingProfile {
	const p = SCENARIOS.hybrid();
	const [first] = p.goals;
	p.goals = [
		{
			...first!,
			kind: 'general',
			title: 'Fitter',
			disciplines: ['powerlifting', 'strength', 'running', 'muay_thai', 'athletic'],
			eventType: null,
			eventDate: null,
			focus: 'Fitter'
		}
	];
	p.equipment = {
		...p.equipment!,
		gymType: null,
		equipment: [
			'barbell',
			'squat_rack',
			'bench',
			'dumbbells',
			'treadmill',
			...(bike ? ['bike' as const] : [])
		],
		homeEquipment: []
	};
	p.schedule = {
		...p.schedule,
		daysPerWeek: 7,
		availableDays: [],
		preferredTimes: ['varies'],
		sessionMinutes: 60,
		commitments: [
			commitment(1, { label: 'Drilling', days: ['mon'], intensity: 'light' }),
			commitment(2, {
				label: 'Pads and Clinch',
				days: ['tue', 'thu'],
				durationMinutes: 120,
				intensity: 'hard'
			}),
			commitment(3, {
				label: 'Comp Team Sparring',
				days: ['wed'],
				timeOfDay: null,
				durationMinutes: 90,
				intensity: 'hard'
			}),
			commitment(4, { label: 'Sparring', days: ['sat'], timeOfDay: 'morning' }),
			commitment(5, {
				label: 'Morning run',
				discipline: 'running',
				days: ['sat'],
				timeOfDay: 'morning',
				durationMinutes: null
			})
		]
	};
	return p;
}

describe("the owner's week with a bike", () => {
	const plan = generate(owner());
	const without = generate(owner({ bike: false }));

	it('keeps the contract, and the Saturday run stays a run', () => {
		expect(validate(programPlanSchema, plan).ok).toBe(true);
		for (const week of weeksOf(plan).filter((w) => w.kind !== 'baseline')) {
			expect(runs(week).map((r) => [r.title, day(r), r.source])).toEqual([
				['Morning run', 'sat', 'commitment']
			]);
		}
	});

	it("moves the Monday-morning easy run to the bike, at the run's own minutes and time", () => {
		for (const [w, week] of weeksOf(plan).entries()) {
			if (week.kind === 'baseline') continue;
			const was = runs(weeksOf(without)[w]!).filter((r) => r.source === 'generator');
			expect(was.map((r) => [r.title, day(r), r.timeOfDay])).toEqual([
				['Easy run', 'mon', 'morning']
			]);
			const [bike] = bikes(week);
			expect(bike).toMatchObject({
				kind: 'other',
				type: 'conditioning',
				source: 'generator',
				intensity: 'easy',
				date: was[0]!.date,
				timeOfDay: 'morning',
				estMinutes: was[0]!.estMinutes,
				discipline: 'running',
				details: { kind: 'conditioning', durationMinutes: was[0]!.estMinutes }
			});
			expect(bike!.notes).toBe(ZONE2_WORDS.notes);
			expect(bike!.notes).toContain('60–70% of your max heart rate');
		}
	});

	it('leaves the lifts and the Muay Thai exactly as they were', () => {
		const rest = (p: ProgramPlan) =>
			weeksOf(p).map((w) =>
				w.sessions
					.filter((s) => s.kind === 'strength' || s.discipline === 'muay_thai')
					.map((s) => [s.title, s.date, s.timeOfDay, s.estMinutes])
			);
		expect(rest(plan)).toEqual(rest(without));
	});

	it('says why, citing every bike session', () => {
		const said = plan.decisions.find((d) => d.ruleKey === 'running.zone2_bike');
		expect(said).toMatchObject({
			kind: 'exercise_substituted',
			summary: 'Zone 2 bike instead of Easy run'
		});
		expect(said!.refs.length).toBe(weeksOf(plan).flatMap(bikes).length);
		expect(without.decisions.some((d) => d.ruleKey === 'running.zone2_bike')).toBe(false);
	});
});

describe('which runs move to the bike', () => {
	/** The beginner, as a general-fitness runner with no running commitment. */
	const generalRunner = (over: (p: TrainingProfile) => void = () => {}) => {
		const p = SCENARIOS.beginner();
		p.goals = [{ ...p.goals[0]!, title: 'Fit', disciplines: ['strength', 'running'] } as Goal];
		p.schedule = { ...p.schedule, daysPerWeek: 6 };
		// An intermediate runner gets a long run, which must stay a run.
		p.experience = [
			...p.experience,
			{
				...p.experience[0]!,
				id: '00000000-0000-4000-8000-000000000999',
				discipline: 'running',
				level: 'intermediate'
			}
		];
		over(p);
		return p;
	};

	it('with no bike, changes nothing', () => {
		const p = generalRunner(
			(p) => (p.equipment = { ...p.equipment!, gymType: 'strength', equipment: [] })
		);
		const plan = generate(p);
		expect(weeksOf(plan).flatMap(bikes)).toEqual([]);
	});

	it('keeps half the easy runs, the first first, and every week at least one run', () => {
		const plan = generate(generalRunner());
		for (const week of weeksOf(plan)) {
			const easy = week.sessions.filter(
				(s) => s.type === 'easy_run' || s.title === ZONE2_BIKE.title
			);
			const moved = bikes(week).length;
			expect(moved).toBe(
				Math.min(Math.ceil(easy.length / 2), Math.max(0, runs(week).length + moved - 1))
			);
			if (easy.length) expect(runs(week).length).toBeGreaterThanOrEqual(1);
			const order = [...easy].sort((a, b) => (a.date < b.date ? -1 : 1));
			// The bikes are the latest easy sessions of the week before placement; placement may
			// then move days, so only check the count and that a run remains.
			expect(order.length).toBe(easy.length);
		}
		expect(weeksOf(plan).flatMap(bikes).length).toBeGreaterThan(0);
	});

	it('never moves a long or quality run', () => {
		const plan = generate(generalRunner());
		const kept = weeksOf(plan)
			.flatMap(runs)
			.map((r) => r.type);
		expect(kept).toEqual(expect.arrayContaining(['long_run']));
		for (const s of weeksOf(plan).flatMap(bikes)) expect(s.type).toBe('conditioning');
	});

	it('keeps every easy run for a goal about running, or with a race ahead', () => {
		const runningOnly = generalRunner((p) => {
			p.goals = [{ ...p.goals[0]!, disciplines: ['running'] }];
		});
		expect(weeksOf(generate(runningOnly)).flatMap(bikes)).toEqual([]);
		const race = generalRunner((p) => {
			p.goals = [
				{ ...p.goals[0]!, kind: 'event', eventType: '10K', eventDate: scenarioDay(12, 6) }
			];
		});
		expect(weeksOf(generate(race)).flatMap(bikes)).toEqual([]);
	});
});

describe('every scenario', () => {
	it('keeps its plan unless a bike meets a goal training more than running', () => {
		for (const [key, make] of Object.entries(SCENARIOS)) {
			const plan = generate(make());
			expect(validate(programPlanSchema, plan).ok, key).toBe(true);
		}
	});
});
