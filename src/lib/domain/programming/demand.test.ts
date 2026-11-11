/**
 * demand.ts, the one day rule: training days from daysPerWeek and the open days, the free days
 * the commitments leave (never negative), each commitment counted toward its quota, the free
 * days given by goal priority, doubles only with two distinct times, and a decision whenever the
 * week cannot give a goal what it asks for.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../exercises/index';
import { DISCIPLINES, WEEKDAYS } from '../profile/catalog';
import type { Commitment, Goal, Schedule, TrainingProfile } from '../profile/types';
import { DecisionLog } from './decisions';
import { allocateWeek, commitmentQuota, generatedFor, weekBudget } from './demand';
import type { StreamShare } from './demand';
import { buildProgrammingInput } from './input';
import type { ProgrammingInput } from './input';
import type { GoalDose } from './priority/doses';
import { SCENARIOS } from './scenarios';

const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });

/** A scenario with its schedule changed and its goals, by M2 priority, as given. */
function variant(
	key: keyof typeof SCENARIOS,
	schedule: Partial<Schedule> = {},
	goals?: (p: TrainingProfile) => Goal[]
): TrainingProfile {
	const p = SCENARIOS[key]();
	return { ...p, goals: goals ? goals(p) : p.goals, schedule: { ...p.schedule, ...schedule } };
}

function allocate(profile: TrainingProfile) {
	const input = inputOf(profile);
	const budget = weekBudget(input);
	const log = new DecisionLog();
	const allocation = allocateWeek(input, budget, log);
	const shares = Object.fromEntries(
		allocation.streams.map((s) => [s.stream, { committed: s.committed, generated: s.generated }])
	) as Record<StreamShare['stream'], Pick<StreamShare, 'committed' | 'generated'>>;
	return { input, budget, allocation, shares, decisions: log.list() };
}

const withPriority = (goal: Goal, priority: number): Goal => ({ ...goal, priority });

const club = (over: Partial<Commitment> & Pick<Commitment, 'discipline' | 'days'>): Commitment => ({
	id: '00000000-0000-4000-8000-000000000299',
	label: 'Club',
	timeOfDay: null,
	durationMinutes: 60,
	intensity: 'moderate',
	notes: null,
	...over
});

describe('weekBudget', () => {
	it('gives 5 days with Tue/Thu commitments 3 free days', () => {
		expect(weekBudget(inputOf(SCENARIOS.journey()))).toEqual({
			days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
			commitmentWeekdays: ['tue', 'thu'],
			trainingDays: 5,
			commitmentDays: 2,
			freeDays: 3,
			doublesAllowed: true
		});
	});

	it('caps training days at the available days, a commitment day counting as one', () => {
		const p = variant('minimal', { daysPerWeek: 5, availableDays: ['mon', 'wed', 'fri'] });
		expect(weekBudget(inputOf(p))).toMatchObject({ days: ['mon', 'wed', 'fri'], trainingDays: 3 });
		const classOnSaturday = variant('minimal', {
			daysPerWeek: 5,
			availableDays: ['mon', 'wed'],
			commitments: [club({ discipline: 'muay_thai', days: ['sat'] })]
		});
		expect(weekBudget(inputOf(classOnSaturday))).toMatchObject({
			days: ['mon', 'wed', 'sat'],
			trainingDays: 3,
			freeDays: 2
		});
	});

	it('takes empty availability as any day of the week', () => {
		const input = inputOf(SCENARIOS.minimal());
		expect(weekBudget(input)).toMatchObject({ days: [...WEEKDAYS], trainingDays: 3, freeDays: 3 });
		expect(input.assumptions).toContainEqual(
			expect.objectContaining({ ruleKey: 'defaults.available_days' })
		);
	});

	it('gives commitments on 4 days with daysPerWeek 3 no free day, never a negative one', () => {
		const p = variant('minimal', {
			commitments: [club({ discipline: 'muay_thai', days: ['mon', 'tue', 'thu', 'fri'] })]
		});
		expect(weekBudget(inputOf(p))).toMatchObject({
			trainingDays: 3,
			commitmentDays: 4,
			freeDays: 0
		});
	});

	it('allows doubles only with two distinct times and sessions of 90 minutes or less', () => {
		const doubles = (schedule: Partial<Schedule>) =>
			weekBudget(inputOf(variant('journey', schedule))).doublesAllowed;
		expect(doubles({ preferredTimes: ['morning', 'evening'] })).toBe(true);
		expect(doubles({ preferredTimes: ['evening'] })).toBe(false);
		expect(doubles({ preferredTimes: ['evening', 'varies'] })).toBe(false);
		expect(doubles({ preferredTimes: [] })).toBe(false);
		expect(doubles({ preferredTimes: ['morning', 'evening'], sessionMinutes: 90 })).toBe(true);
		expect(doubles({ preferredTimes: ['morning', 'evening'], sessionMinutes: 120 })).toBe(false);
	});
});

describe('commitmentQuota', () => {
	it('counts a club toward runs, strength days or other sessions by its discipline', () => {
		const quota = Object.fromEntries(
			DISCIPLINES.map((d) => [d, commitmentQuota({ discipline: d })])
		);
		expect(quota).toEqual({
			powerlifting: 'strength',
			weightlifting: 'strength',
			strength: 'strength',
			hypertrophy: 'strength',
			running: 'runs',
			distance_running: 'runs',
			muay_thai: 'other',
			athletic: 'other',
			custom: 'other'
		});
	});

	it('takes a running club off the generated runs and a strength class off the strength days', () => {
		const runClub = allocate(
			variant('hybrid', {
				daysPerWeek: 6,
				commitments: [
					club({ discipline: 'running', label: 'Run club', days: ['wed'] }),
					...SCENARIOS.hybrid().schedule.commitments
				]
			})
		);
		expect(runClub.shares.runs).toEqual({ committed: 1, generated: 2 });
		const strengthClass = allocate(
			variant('minimal', { commitments: [club({ discipline: 'strength', days: ['mon'] })] })
		);
		expect(strengthClass.shares.strength).toEqual({ committed: 1, generated: 2 });
		expect(strengthClass.budget.freeDays).toBe(2);
	});
});

describe('allocateWeek', () => {
	it('gives 3 free days to the goals by priority, and drops the lowest-priority sessions', () => {
		const { shares, allocation, decisions } = allocate(
			variant('journey', { preferredTimes: ['evening'] })
		);
		expect(allocation.streams.map((s) => s.stream)).toEqual(['muay_thai', 'runs', 'strength']);
		expect(shares).toEqual({
			muay_thai: { committed: 2, generated: 0 },
			runs: { committed: 0, generated: 3 },
			strength: { committed: 0, generated: 0 }
		});
		expect(allocation).toMatchObject({ doubles: 0, mobility: 0 });
		const [days] = decisions.filter((d) => d.kind === 'day_allocation');
		expect(days).toMatchObject({ ruleKey: 'days.free_days', summary: '5 training days a week' });
		expect(days!.why).toBe(
			'You train 5 days a week. Your fixed commitments take 2, which leaves 3 free: 3 runs for Marathon.'
		);
		expect(decisions.filter((d) => d.kind === 'session_dropped')).toEqual([
			expect.objectContaining({
				ruleKey: 'days.dropped',
				summary: '2 of 2 strength sessions left out this week',
				why: expect.stringContaining('two distinct preferred times')
			})
		]);
	});

	it('follows the ranking when it changes: strength above the marathon gets its days first', () => {
		const rank: Record<string, number> = { Fight: 1, 'Keep strength': 2, Marathon: 3 };
		const strengthFirst = variant('journey', { preferredTimes: ['evening'] }, (p) =>
			p.goals.map((g) => withPriority(g, rank[g.title]!))
		);
		const { shares, decisions } = allocate(strengthFirst);
		expect(shares.strength).toEqual({ committed: 0, generated: 2 });
		expect(shares.runs).toEqual({ committed: 0, generated: 1 });
		expect(decisions.find((d) => d.kind === 'session_dropped')?.summary).toBe(
			'2 of 3 runs left out this week'
		);
	});

	it('records a priority trade-off when a goal between others loses its days', () => {
		const p = variant('minimal', { daysPerWeek: 3 }, (base) => [
			{ ...base.goals[0]!, title: 'Marathon', disciplines: ['distance_running'] },
			{ ...base.goals[0]!, id: '00000000-0000-4000-8000-000000000102', priority: 2 },
			{
				...base.goals[0]!,
				id: '00000000-0000-4000-8000-000000000103',
				title: 'Pads',
				disciplines: ['muay_thai'],
				priority: 3
			}
		]);
		const { shares, decisions } = allocate(p);
		expect(shares).toMatchObject({ runs: { generated: 3 }, strength: { generated: 0 } });
		expect(decisions.filter((d) => d.kind === 'priority_tradeoff')).toEqual([
			expect.objectContaining({ ruleKey: 'days.priority', summary: 'Marathon over Get stronger' })
		]);
		expect(decisions.filter((d) => d.kind === 'session_dropped')).toEqual([
			expect.objectContaining({ summary: '2 of 2 Muay Thai sessions left out this week' })
		]);
	});

	describe('a second session on a Muay Thai day', () => {
		const fightAndMarathon = (preferredTimes: Schedule['preferredTimes']) =>
			variant('journey', { daysPerWeek: 4, preferredTimes }, (p) => p.goals.slice(0, 2));

		it('takes the run the free days cannot hold, with morning and evening preferred', () => {
			const { shares, allocation, decisions } = allocate(fightAndMarathon(['morning', 'evening']));
			expect(shares.runs).toEqual({ committed: 0, generated: 3 });
			expect(allocation.doubles).toBe(1);
			expect(decisions.find((d) => d.kind === 'day_allocation')?.why).toContain(
				'3 runs for Marathon, 1 of them as a second session on a commitment day'
			);
			expect(decisions.filter((d) => d.kind === 'session_dropped')).toEqual([]);
		});

		it.each([[['evening']], [['evening', 'varies']], [[]]] as const)(
			'is not allowed with %j: the lowest-priority session is dropped',
			(times) => {
				const { shares, allocation, decisions } = allocate(fightAndMarathon([...times]));
				expect(shares.runs).toEqual({ committed: 0, generated: 2 });
				expect(allocation.doubles).toBe(0);
				expect(decisions.filter((d) => d.kind === 'session_dropped')).toEqual([
					expect.objectContaining({ summary: '1 of 3 runs left out this week' })
				]);
			}
		);

		it('fits the journey: its 3 runs and both strength sessions, 2 of them doubled', () => {
			const { shares, allocation } = allocate(SCENARIOS.journey());
			expect(shares).toMatchObject({ runs: { generated: 3 }, strength: { generated: 2 } });
			expect(allocation.doubles).toBe(2);
		});
	});

	it('fills every goal’s fewest first, then the spare days by turns, then mobility', () => {
		const strengthAndRunning = (daysPerWeek: number) =>
			allocate(
				variant('minimal', { daysPerWeek }, (p) => [
					p.goals[0]!,
					{
						...p.goals[0]!,
						id: '00000000-0000-4000-8000-000000000102',
						title: '10K',
						disciplines: ['running'],
						priority: 2
					}
				])
			);
		expect(strengthAndRunning(4).shares).toMatchObject({
			strength: { generated: 2 },
			runs: { generated: 2 }
		});
		expect(strengthAndRunning(5).shares).toMatchObject({
			strength: { generated: 3 },
			runs: { generated: 2 }
		});
		const allWeek = strengthAndRunning(7);
		expect(allWeek.shares).toMatchObject({ strength: { generated: 4 }, runs: { generated: 3 } });
		expect(allWeek.allocation.mobility).toBe(0);
		const strengthOnly = allocate(variant('minimal', { daysPerWeek: 6 }));
		expect(generatedFor(strengthOnly.allocation, 'strength')).toBe(4);
		expect(generatedFor(strengthOnly.allocation, 'runs')).toBe(0);
		expect(strengthOnly.allocation.mobility).toBe(2);
		expect(strengthOnly.decisions[0]!.why).toContain(
			'4 strength sessions for Get stronger, 2 mobility sessions'
		);
	});

	it('says no day is added when commitments fill the stated days', () => {
		const { allocation, decisions } = allocate(
			variant('minimal', {
				commitments: [club({ discipline: 'muay_thai', days: ['mon', 'tue', 'thu', 'fri'] })]
			})
		);
		expect(generatedFor(allocation, 'strength')).toBe(0);
		const days = decisions.filter((d) => d.kind === 'day_allocation');
		expect(days).toEqual([
			expect.objectContaining({
				ruleKey: 'days.commitments_fill',
				summary: '4 training days a week',
				why: 'You train 3 days a week. Your fixed commitments take 4, which leaves 0 free: your commitments fill the days you train, so no day is added; nothing else is planned.'
			})
		]);
	});

	it('says when fewer days are available than the days a week asked for', () => {
		const { decisions } = allocate(
			variant('minimal', { daysPerWeek: 5, availableDays: ['mon', 'wed', 'fri'] })
		);
		expect(decisions[0]).toMatchObject({
			summary: '3 training days a week',
			why: 'You train 5 days a week, but only 3 days are available. Your fixed commitments take 0, which leaves 3 free: 3 strength sessions for Get stronger.'
		});
	});

	it('plans every paused goal’s fewest, and no more, when all are paused', () => {
		const paused = variant('minimal', { daysPerWeek: 5 }, (p) =>
			p.goals.map((g) => ({ ...g, status: 'paused' as const }))
		);
		const { shares, allocation } = allocate(paused);
		expect(shares.strength).toEqual({ committed: 0, generated: 2 });
		expect(allocation.mobility).toBe(3);
	});
});

describe('allocateWeek with doses (generator-season)', () => {
	/** The 10K first and Get stronger second, `extra` goals after them, 7 days a week. */
	const runnerFirst = (extra: Goal[] = []) =>
		inputOf(
			variant('minimal', { daysPerWeek: 7 }, (p) => [
				{
					...p.goals[0]!,
					id: '00000000-0000-4000-8000-000000000102',
					title: '10K',
					disciplines: ['running'],
					priority: 1
				},
				withPriority(p.goals[0]!, 2),
				...extra
			])
		);
	/** Goal `title` of `input` held at a dose of at most `max` sessions of `stream`. */
	const heldAt = (
		input: ProgrammingInput,
		title: string,
		stream: GoalDose['stream'],
		max: number
	): GoalDose => {
		const i = input.goals.findIndex((g) => g.title === title);
		return {
			stream,
			goal: { id: input.refs.goals[i]!, title },
			leader: null,
			dose: { stream: 'custom', sessions: { min: 1, max }, words: `${max} sessions` },
			reason: 'Held while the 10K leads.'
		};
	};
	const run = (input: ProgrammingInput, doses?: GoalDose[]) => {
		const log = new DecisionLog();
		const allocation = allocateWeek(input, weekBudget(input), log, doses);
		return { allocation, decisions: log.list() };
	};
	const generated = (a: ReturnType<typeof run>['allocation']) =>
		Object.fromEntries(a.streams.map((s) => [s.stream, s.generated]));

	it('changes nothing without doses', () => {
		const input = runnerFirst();
		expect(run(input, [])).toEqual(run(input));
		expect(generated(run(input).allocation)).toEqual({ runs: 4, strength: 3 });
	});

	it('caps a stream only dosed goals train, and gives the days it frees to the leader first', () => {
		const input = runnerFirst();
		const { allocation, decisions } = run(input, [heldAt(input, 'Get stronger', 'strength', 2)]);
		expect(generated(allocation)).toEqual({ runs: 5, strength: 2 });
		expect(allocation.mobility).toBe(0);
		expect(decisions[0]!.why).toContain('5 runs for 10K, 2 strength sessions for Get stronger');
	});

	it('counts a muscle-building dose toward the strength days, and caps the fewest too', () => {
		const input = runnerFirst();
		const i = input.goals.findIndex((g) => g.title === 'Get stronger');
		input.goals[i] = { ...input.goals[i]!, disciplines: ['hypertrophy'] };
		input.disciplines = ['running', 'hypertrophy'];
		// Hypertrophy wants 3 at the fewest; its dose of 1 is the most it gets.
		const held = run(input, [heldAt(input, 'Get stronger', 'hypertrophy', 1)]);
		expect(generated(held.allocation)).toEqual({ runs: 5, strength: 1 });
	});

	it('leaves a stream alone while a goal that is not dosed trains it too', () => {
		const p = SCENARIOS.minimal();
		const size = {
			...p.goals[0]!,
			id: '00000000-0000-4000-8000-000000000103',
			title: 'Build size',
			disciplines: ['strength' as const],
			priority: 3
		};
		const input = runnerFirst([size]);
		const dosed = run(input, [heldAt(input, 'Get stronger', 'strength', 1)]);
		expect(dosed).toEqual(run(input));
	});

	it('ignores doses when every goal is paused: M3 already holds each stream at its fewest', () => {
		const paused = inputOf(
			variant('minimal', { daysPerWeek: 5 }, (p) =>
				p.goals.map((g) => ({ ...g, status: 'paused' as const }))
			)
		);
		const dose: GoalDose = {
			stream: 'strength',
			goal: { id: paused.refs.paused[0]!, title: paused.paused[0]!.title },
			leader: null,
			dose: { stream: 'custom', sessions: { min: 1, max: 1 }, words: '1 session' },
			reason: 'Paused.'
		};
		expect(run(paused, [dose])).toEqual(run(paused));
	});
});
