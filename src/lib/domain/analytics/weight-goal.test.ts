import { describe, expect, it } from 'vitest';
import { addDays } from '../calendar';
import type { WeightUnit } from '../units';
import {
	ACTUAL_RATE_DAYS,
	DEFAULT_MILESTONE_STEP,
	directionOf,
	generateMilestones,
	goalLine,
	goalStatus,
	type Milestone,
	MILESTONES_MAX,
	milestoneStatus,
	phaseSuggestion,
	type WeightGoal,
	validateMilestones
} from './weight-goal';
import { dailyTrend, weeklyRate, type WeighIn } from './weight';

/** The goal starts on day 0 of START; `at(n)` is n days after it. */
const START = '2026-06-01';
const at = (days: number) => addDays(START, days);

/** 90 kg on the start, 80 kg a hundred days later: a loss. */
const LOSS: WeightGoal = {
	unit: 'kg',
	startOn: at(0),
	startWeight: 90,
	targetOn: at(100),
	targetWeight: 80
};
/** 70 kg to 80 kg over the same hundred days: a gain. */
const GAIN: WeightGoal = { ...LOSS, startWeight: 70, targetWeight: 80 };
/** 80 kg held over the hundred days: a maintain. */
const MAINTAIN: WeightGoal = { ...LOSS, startWeight: 80, targetWeight: 80 };
/** 180 lb to 170 lb over a hundred days: a loss, entered in pounds. */
const LB_LOSS: WeightGoal = { ...LOSS, unit: 'lb', startWeight: 180, targetWeight: 170 };

/** The days from `from` to `to`, both included. */
const range = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** A weigh-in of `value` (in `unit`) on each of `days`, as a trend series in that unit. */
const flat = (value: number, days: readonly number[], unit: WeightUnit = 'kg') =>
	dailyTrend(
		days.map((n) => ({ measuredOn: at(n), value, unit }) satisfies WeighIn),
		unit
	);

describe('the goal line: straight from the start to the target', () => {
	it('is the start weight on the start day and the target weight on the target day', () => {
		expect(goalLine(LOSS, at(0))).toBe(90);
		expect(goalLine(LOSS, at(100))).toBe(80);
	});

	it('runs straight between them', () => {
		expect(goalLine(LOSS, at(50))).toBe(85);
		expect(goalLine(LOSS, at(25))).toBe(87.5);
	});

	it('is clamped outside the two dates: flat before the start and after the target', () => {
		expect(goalLine(LOSS, at(-10))).toBe(90);
		expect(goalLine(LOSS, at(130))).toBe(80);
	});

	it('is read in the goal’s own unit', () => {
		expect(goalLine(LB_LOSS, at(50))).toBe(175);
	});

	it('gives a loss, a gain or a maintain by the two weights', () => {
		expect(directionOf(LOSS)).toBe('loss');
		expect(directionOf(GAIN)).toBe('gain');
		expect(directionOf(MAINTAIN)).toBe('maintain');
	});

	it('refuses a goal whose target day is not after its start', () => {
		expect(() => goalLine({ ...LOSS, targetOn: at(0) }, at(10))).toThrow(RangeError);
	});
});

describe('milestones by weight step', () => {
	it('falls on every multiple of the step between the start and the target, dated where the line reaches it', () => {
		expect(generateMilestones(LOSS, { kind: 'weight', step: 2 })).toEqual({
			ok: true,
			milestones: [
				{ day: at(20), weight: 88 },
				{ day: at(40), weight: 86 },
				{ day: at(60), weight: 84 },
				{ day: at(80), weight: 82 }
			]
		});
	});

	it('dates each milestone to the nearest day', () => {
		// The line falls 3 kg over 10 days, so 88 kg is two thirds of the way: 6.67 days, rounded to 7.
		const goal = { ...LOSS, targetOn: at(10), targetWeight: 87 };
		expect(generateMilestones(goal, { kind: 'weight', step: 2 })).toEqual({
			ok: true,
			milestones: [{ day: at(7), weight: 88 }]
		});
	});

	it('leaves out the start and the target weight themselves', () => {
		// Between 88 and 90 there is no multiple of 2 that is not one of the two ends.
		const goal = { ...LOSS, targetWeight: 88 };
		expect(generateMilestones(goal, { kind: 'weight', step: 2 })).toEqual({
			ok: true,
			milestones: []
		});
	});

	it('defaults to 2 kg or 5 lb', () => {
		expect(DEFAULT_MILESTONE_STEP).toEqual({ kg: 2, lb: 5 });
		// 180 to 170 lb: the only multiple of 5 in between is 175, the line's midpoint.
		expect(
			generateMilestones(LB_LOSS, { kind: 'weight', step: DEFAULT_MILESTONE_STEP.lb })
		).toEqual({ ok: true, milestones: [{ day: at(50), weight: 175 }] });
	});

	it('runs a gain upward from the start', () => {
		expect(generateMilestones(GAIN, { kind: 'weight', step: 5 })).toEqual({
			ok: true,
			milestones: [{ day: at(50), weight: 75 }]
		});
	});

	it('makes no milestones for a maintain goal', () => {
		expect(generateMilestones(MAINTAIN, { kind: 'weight', step: 2 })).toEqual({
			ok: true,
			milestones: []
		});
	});
});

describe('milestones by month', () => {
	it('falls on each monthly anniversary of the start before the target, weighted by the line', () => {
		// From 31 January 2026 to 15 June 2026 the line runs 135 days, 10 kg down.
		const goal: WeightGoal = {
			...LOSS,
			startOn: '2026-01-31',
			targetOn: '2026-06-15'
		};
		expect(generateMilestones(goal, { kind: 'month' })).toEqual({
			ok: true,
			milestones: [
				{ day: '2026-02-28', weight: 87.93 },
				{ day: '2026-03-31', weight: 85.63 },
				{ day: '2026-04-30', weight: 83.41 },
				{ day: '2026-05-31', weight: 81.11 }
			]
		});
	});

	it('takes the same day of the month each time, and the last day when the month is shorter', () => {
		const goal: WeightGoal = { ...LOSS, startOn: '2026-01-31', targetOn: '2026-04-01' };
		const result = generateMilestones(goal, { kind: 'month' });
		expect(result.ok && result.milestones.map((m) => m.day)).toEqual(['2026-02-28', '2026-03-31']);
	});

	it('makes one milestone a month for each full month before the target', () => {
		const goal: WeightGoal = { ...LOSS, startOn: '2026-01-01', targetOn: '2028-01-01' };
		const result = generateMilestones(goal, { kind: 'month' });
		expect(result.ok && result.milestones).toHaveLength(23);
	});
});

describe('the milestone cap', () => {
	it('refuses more than 24 milestones from weight steps', () => {
		// 0.25 kg steps between 80 and 90 kg make 39.
		expect(generateMilestones(LOSS, { kind: 'weight', step: 0.25 })).toEqual({
			ok: false,
			reason: 'too_many'
		});
	});

	it('accepts exactly 24', () => {
		// 0.4 kg steps between 80 and 90 kg make 24.
		const result = generateMilestones(LOSS, { kind: 'weight', step: 0.4 });
		expect(result.ok && result.milestones).toHaveLength(MILESTONES_MAX);
	});

	it('refuses more than 24 milestones from months', () => {
		// Three years of anniversaries make 35.
		const goal: WeightGoal = { ...LOSS, startOn: '2026-01-01', targetOn: '2029-01-01' };
		expect(generateMilestones(goal, { kind: 'month' })).toEqual({
			ok: false,
			reason: 'too_many'
		});
	});
});

describe('validating edited milestones', () => {
	const valid: Milestone[] = [
		{ day: at(20), weight: 88 },
		{ day: at(40), weight: 86 }
	];

	it('accepts a list with every day strictly inside the goal and unique', () => {
		expect(validateMilestones(LOSS, valid)).toEqual([]);
		expect(validateMilestones(LOSS, [])).toEqual([]);
	});

	it('refuses a day on or outside the start and the target', () => {
		expect(validateMilestones(LOSS, [{ day: at(0), weight: 88 }])).toEqual([
			{ index: 0, problem: 'outside_goal' }
		]);
		expect(validateMilestones(LOSS, [{ day: at(100), weight: 88 }])).toEqual([
			{ index: 0, problem: 'outside_goal' }
		]);
		expect(validateMilestones(LOSS, [{ day: at(-5), weight: 88 }])).toEqual([
			{ index: 0, problem: 'outside_goal' }
		]);
	});

	it('names the later of two milestones that share a day', () => {
		expect(
			validateMilestones(LOSS, [
				{ day: at(20), weight: 88 },
				{ day: at(20), weight: 87 }
			])
		).toEqual([{ index: 1, problem: 'same_day' }]);
	});

	it('checks each weight against the range for its unit', () => {
		expect(validateMilestones(LOSS, [{ day: at(20), weight: 20 }])).toEqual([
			{ index: 0, problem: 'weight_out_of_range' }
		]);
		expect(validateMilestones(LB_LOSS, [{ day: at(20), weight: 40 }])).toEqual([
			{ index: 0, problem: 'weight_out_of_range' }
		]);
		expect(validateMilestones(LB_LOSS, [{ day: at(20), weight: 60 }])).toEqual([]);
	});

	it('refuses an edited list longer than 24', () => {
		const many = Array.from({ length: 25 }, (_, i) => ({ day: at(i + 1), weight: 85 }));
		expect(validateMilestones(LOSS, many)).toEqual([{ index: null, problem: 'too_many' }]);
	});
});

describe('the goal status: on track, ahead or behind', () => {
	it('is on track at 0.5 kg from the line, with the gap and the rate it needs', () => {
		// Day 50 is 85 kg on the line; the trend is 84.5 kg, 0.5 kg below it.
		const status = goalStatus(LOSS, flat(84.5, range(0, 50)), at(50), 'kg');
		expect(status).toMatchObject({
			verdict: 'on_track',
			trend: 84.5,
			line: 85,
			gap: 0.5,
			// 4.5 kg still to lose over 50 days: 0.63 kg a week.
			requiredRate: -0.63,
			actualRate: 0,
			percentDone: 55,
			distanceLeft: 4.5,
			daysLeft: 50,
			nextMilestone: null,
			stale: false
		});
	});

	it('is on track at 1 lb from the line in pounds', () => {
		// Day 50 is 175 lb on the line; the trend is 174 lb, a pound below it.
		expect(goalStatus(LB_LOSS, flat(174, range(0, 50), 'lb'), at(50), 'lb')).toMatchObject({
			verdict: 'on_track',
			gap: 1
		});
	});

	it('uses the tolerance of the unit: 0.6 lb is on track, 0.6 kg is not', () => {
		expect(goalStatus(LB_LOSS, flat(175.6, range(0, 50), 'lb'), at(50), 'lb').verdict).toBe(
			'on_track'
		);
		expect(goalStatus(LOSS, flat(85.6, range(0, 50)), at(50), 'kg').verdict).toBe('behind');
	});

	it('is ahead when the trend is further than the tolerance below a loss line', () => {
		expect(goalStatus(LOSS, flat(83, range(0, 50)), at(50), 'kg')).toMatchObject({
			verdict: 'ahead',
			gap: 2
		});
	});

	it('is behind when the trend is further than the tolerance above a loss line, with the rate needed', () => {
		const status = goalStatus(LOSS, flat(86.5, range(0, 50)), at(50), 'kg');
		expect(status).toMatchObject({
			verdict: 'behind',
			gap: 1.5,
			// 6.5 kg still to lose over 50 days: 0.91 kg a week.
			requiredRate: -0.91,
			percentDone: 35,
			distanceLeft: 6.5
		});
	});

	it('judges a gain the other way round', () => {
		// Day 50 is 75 kg on the line.
		expect(goalStatus(GAIN, flat(75, range(0, 50)), at(50), 'kg')).toMatchObject({
			verdict: 'on_track',
			percentDone: 50,
			// 5 kg still to gain over 50 days: 0.7 kg a week.
			requiredRate: 0.7,
			distanceLeft: 5
		});
		expect(goalStatus(GAIN, flat(77, range(0, 50)), at(50), 'kg').verdict).toBe('ahead');
		expect(goalStatus(GAIN, flat(73, range(0, 50)), at(50), 'kg').verdict).toBe('behind');
	});

	it('reads a goal entered in pounds in the unit asked for', () => {
		// 175 lb on the line is 79.38 kg.
		const status = goalStatus(LB_LOSS, flat(79.38, range(0, 50)), at(50), 'kg');
		expect(status).toMatchObject({ verdict: 'on_track', line: 79.38 });
	});

	it('reads the actual rate as the trend’s weekly rate over the last 28 days', () => {
		// Falling 0.1 kg a day: the rate over days 23 to 50 is down, and the window is 28 days inclusive.
		const falling = dailyTrend(
			range(0, 50).map((n) => ({ measuredOn: at(n), value: 90 - 0.1 * n, unit: 'kg' })),
			'kg'
		);
		const status = goalStatus(LOSS, falling, at(50), 'kg');
		expect(ACTUAL_RATE_DAYS).toBe(28);
		expect(status.verdict).not.toBe('no_data');
		if (status.verdict === 'no_data') return;
		expect(status.actualRate).toBe(weeklyRate(falling, at(23), at(50)));
		expect(status.actualRate).toBeLessThan(0);
	});

	it('gives no data without a trend today, or with no weigh-in on or after the start less 30 days', () => {
		expect(goalStatus(LOSS, [], at(50), 'kg')).toEqual({ verdict: 'no_data' });
		// The only weigh-ins are 31 and more days before the start.
		expect(goalStatus(LOSS, flat(88, range(-60, -31)), at(50), 'kg')).toEqual({
			verdict: 'no_data'
		});
	});

	it('counts a weigh-in exactly 30 days before the start', () => {
		const status = goalStatus(LOSS, flat(88, [-30]), at(50), 'kg');
		expect(status.verdict).not.toBe('no_data');
	});

	it('is stale once the last weigh-in is more than 7 days before today', () => {
		expect(goalStatus(LOSS, flat(80, range(0, 110)), at(120), 'kg')).toMatchObject({
			stale: true
		});
	});

	it('has no required rate once the target day has passed, and no days left', () => {
		// Weighed at 80 kg until day 110, then the target day has passed by day 120.
		expect(goalStatus(LOSS, flat(80, range(0, 110)), at(120), 'kg')).toMatchObject({
			verdict: 'on_track',
			requiredRate: null,
			daysLeft: 0,
			distanceLeft: 0,
			percentDone: 100
		});
	});

	it('clamps percent done to 0 to 100', () => {
		// Below the target, the trend has done more than the whole loss.
		expect(goalStatus(LOSS, flat(70, range(0, 50)), at(50), 'kg')).toMatchObject({
			percentDone: 100,
			distanceLeft: 0
		});
	});

	it('names the first milestone on or after today as the next', () => {
		const milestones = generateMilestones(LOSS, { kind: 'weight', step: 2 });
		const list = milestones.ok ? milestones.milestones : [];
		expect(goalStatus(LOSS, flat(84.5, range(0, 50)), at(50), 'kg', list)).toMatchObject({
			nextMilestone: { day: at(60), weight: 84 }
		});
		expect(goalStatus(LOSS, flat(84.5, range(0, 60)), at(60), 'kg', list)).toMatchObject({
			nextMilestone: { day: at(60), weight: 84 }
		});
	});
});

describe('a maintain goal', () => {
	it('is on track within the tolerance of its weight, and behind beyond it', () => {
		expect(directionOf(MAINTAIN)).toBe('maintain');
		expect(goalStatus(MAINTAIN, flat(80.4, range(0, 50)), at(50), 'kg')).toMatchObject({
			verdict: 'on_track',
			percentDone: 100
		});
		expect(goalStatus(MAINTAIN, flat(79.4, range(0, 50)), at(50), 'kg')).toMatchObject({
			verdict: 'behind',
			percentDone: 0
		});
	});

	it('is never ahead, however far the trend is from its weight', () => {
		expect(goalStatus(MAINTAIN, flat(70, range(0, 50)), at(50), 'kg').verdict).toBe('behind');
		expect(goalStatus(MAINTAIN, flat(90, range(0, 50)), at(50), 'kg').verdict).toBe('behind');
	});
});

describe('the milestone status: past milestones hit or missed, upcoming ones judged on the path', () => {
	const milestones = (goal: WeightGoal) => {
		const result = generateMilestones(goal, { kind: 'weight', step: 2 });
		return result.ok ? result.milestones : [];
	};

	it('hits a past milestone the trend reached, and misses one it did not', () => {
		// Weighed at 88 kg from the start: the trend is 88 on day 20 and still 88 on day 40.
		const readings = milestoneStatus(LOSS, milestones(LOSS), flat(88, range(0, 50)), at(50), 'kg');
		expect(readings.slice(0, 2).map((r) => r.status)).toEqual(['hit', 'missed']);
	});

	it('hits a past milestone the trend went beyond in the goal’s direction', () => {
		// Weighed at 84 kg: below the 88 kg and 86 kg milestones, so both are hit.
		const readings = milestoneStatus(LOSS, milestones(LOSS), flat(84, range(0, 50)), at(50), 'kg');
		expect(readings.slice(0, 2).map((r) => r.status)).toEqual(['hit', 'hit']);
	});

	it('judges upcoming milestones on the path at today: behind when the trend is above it', () => {
		// The path at day 50 runs 86 kg (day 40) to 84 kg (day 60): 85 kg. The trend is 88 kg.
		const readings = milestoneStatus(LOSS, milestones(LOSS), flat(88, range(0, 50)), at(50), 'kg');
		expect(readings.slice(2).map((r) => r.status)).toEqual(['behind', 'behind']);
	});

	it('judges upcoming milestones ahead when the trend is below the path', () => {
		// The trend is 84 kg against the 85 kg path.
		const readings = milestoneStatus(LOSS, milestones(LOSS), flat(84, range(0, 50)), at(50), 'kg');
		expect(readings.slice(2).map((r) => r.status)).toEqual(['ahead', 'ahead']);
	});

	it('moves the upcoming verdict when a milestone is edited, since the path bends', () => {
		// Moving the 60-day milestone to 83 kg bends the path at day 50 to 84.5 kg, so an 84 kg trend is on track.
		const edited: Milestone[] = [
			{ day: at(20), weight: 88 },
			{ day: at(40), weight: 86 },
			{ day: at(60), weight: 83 }
		];
		const readings = milestoneStatus(LOSS, edited, flat(84, range(0, 50)), at(50), 'kg');
		expect(readings.map((r) => r.status)).toEqual(['hit', 'hit', 'on_track']);
	});
});

describe('the nutrition phase suggestion', () => {
	it('suggests cut for a loss and bulk for a gain', () => {
		expect(phaseSuggestion('loss', null)).toBe('cut');
		expect(phaseSuggestion('loss', 'maintenance')).toBe('cut');
		expect(phaseSuggestion('loss', 'bulk')).toBe('cut');
		expect(phaseSuggestion('gain', null)).toBe('bulk');
		expect(phaseSuggestion('gain', 'cut')).toBe('bulk');
	});

	it('suggests nothing when the phase already matches', () => {
		expect(phaseSuggestion('loss', 'cut')).toBeNull();
		expect(phaseSuggestion('gain', 'bulk')).toBeNull();
	});

	it('suggests nothing for a maintain goal', () => {
		expect(phaseSuggestion('maintain', null)).toBeNull();
		expect(phaseSuggestion('maintain', 'cut')).toBeNull();
	});
});
