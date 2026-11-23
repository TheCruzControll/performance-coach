/**
 * The owner's weight goal, read against the trend (weight.ts): the goal line from the start to the
 * target, the milestones that split it, the on-track verdict today and at each milestone, and the
 * nutrition phase a goal suggests. Like weight.ts it is pure and server-only at runtime: the
 * services store the goal and its milestones, and the screens and the coach receive these results.
 *
 * The method:
 *
 * 1. The goal line is a straight line from (startOn, startWeight) to (targetOn, targetWeight), held
 *    flat before and after those dates. A goal is a loss, a gain or a maintain, by its weights.
 * 2. Today is judged on the trend (weight.ts), never on a single weigh-in. The gap is
 *    |trend − line|. On track when the gap is within TOLERANCE; ahead when the trend is further
 *    than that in the goal's direction; otherwise behind. A maintain goal is never ahead.
 * 3. A milestone that has passed is hit when the trend on its day is within TOLERANCE of its weight
 *    or beyond it in the goal's direction, and missed otherwise. An upcoming milestone is judged
 *    against the path through the start, the milestones and the target, at today's date, so editing
 *    the milestones moves the verdict.
 *
 * Milestones are in the goal's unit (the unit it was entered in). The figures read against the trend
 * are in the unit asked for: the goal and the milestones are converted into it first. Outputs are
 * rounded to 2 decimals (cleanFloat), and each difference is rounded before it is compared with
 * TOLERANCE, so float noise never decides a verdict.
 *
 * Conventions for src/lib/domain/analytics (M6), as in weight.ts: pure (no I/O, clock or
 * randomness), imported by path, server-only at runtime. The range BODY_WEIGHT_RANGE comes from
 * profile/schemas.ts, so this module loads zod/mini through it; no schema is built here.
 */
import { addDays, daysBetween } from '../calendar.ts';
import type { IsoDate } from '../calendar.ts';
import type { NutritionPhase } from '../profile/catalog.ts';
import { BODY_WEIGHT_RANGE } from '../profile/schemas.ts';
import { cleanFloat, convertWeight } from '../units.ts';
import type { WeightUnit } from '../units.ts';
import { TOLERANCE, trendOn, weeklyRate } from './weight.ts';
import type { TrendDay } from './weight.ts';

/** The actual rate is the trend's weekly rate over this many days, the window ending today. */
export const ACTUAL_RATE_DAYS = 28;
/** A goal has at most this many milestones. */
export const MILESTONES_MAX = 24;
/** The default step between weight milestones, per unit. */
export const DEFAULT_MILESTONE_STEP: Record<WeightUnit, number> = { kg: 2, lb: 5 };
/** A goal is judged only with a weigh-in this many days before its start, or later. */
const WEIGHIN_LOOKBACK_DAYS = 30;

/** Loss: the target is lighter than the start. Gain: heavier. Maintain: the same weight. */
export type Direction = 'loss' | 'gain' | 'maintain';

/** The goal: a straight line from the start to the target, both in `unit`. */
export interface WeightGoal {
	unit: WeightUnit;
	startOn: IsoDate;
	startWeight: number;
	targetOn: IsoDate;
	targetWeight: number;
}

/** A milestone: the weight the goal should have reached by `day`, in the goal's unit. */
export interface Milestone {
	day: IsoDate;
	weight: number;
}

/** How milestones are generated: every `step` in weight, or on each monthly anniversary of the start. */
export type MilestoneBy = { kind: 'weight'; step: number } | { kind: 'month' };

export type GeneratedMilestones =
	{ ok: true; milestones: Milestone[] } | { ok: false; reason: 'too_many' };

/** A problem with one milestone (by its index in the list), or with the list as a whole (null). */
export interface MilestoneIssue {
	index: number | null;
	problem: 'outside_goal' | 'same_day' | 'weight_out_of_range' | 'too_many';
}

export type GoalVerdict = 'on_track' | 'ahead' | 'behind';

/**
 * The goal's status today. `no_data` when there is no trend today, or no weigh-in on or after the
 * start less WEIGHIN_LOOKBACK_DAYS. Otherwise every figure is in the unit asked for.
 */
export type GoalStatus =
	| { verdict: 'no_data' }
	| {
			verdict: GoalVerdict;
			/** The trend today. */
			trend: number;
			/** The goal line today. */
			line: number;
			/** |trend − line|. */
			gap: number;
			/** The weekly change needed from the trend to reach the target by target_on; null once it has passed. */
			requiredRate: number | null;
			/** The trend's weekly rate over ACTUAL_RATE_DAYS; null when the window has too little data. */
			actualRate: number | null;
			/** Progress from the start toward the target, 0 to 100. A maintain goal is 100 on track, else 0. */
			percentDone: number;
			/** How far the trend is from the target, on the far side of it, never below 0 (a maintain goal: the distance). */
			distanceLeft: number;
			/** Days from today to the target day, never below 0. */
			daysLeft: number;
			/** The first milestone on or after today, in the unit asked for. */
			nextMilestone: Milestone | null;
			/** The trend is stale: the last weigh-in is more than STALE_DAYS before today. */
			stale: boolean;
	  };

/** How a milestone stands: hit or missed once its day has passed, else judged on the path. */
export type MilestoneState = 'hit' | 'missed' | 'ahead' | 'on_track' | 'behind' | 'no_data';

/** A milestone in the unit asked for, with its state. */
export interface MilestoneReading extends Milestone {
	status: MilestoneState;
}

/** cleanFloat to 2 decimals, with −0 read as 0 (as in weight.ts). */
const round = (value: number) => cleanFloat(value, 2) + 0;

const byDay = (a: Milestone, b: Milestone) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0);

/** The goal as stored: its target day after its start, and both weights positive. */
function checked(goal: WeightGoal): WeightGoal {
	if (!(goal.startOn < goal.targetOn)) {
		throw new RangeError(
			`A goal's target day must be after its start: ${goal.startOn}, ${goal.targetOn}`
		);
	}
	for (const weight of [goal.startWeight, goal.targetWeight]) {
		if (!(Number.isFinite(weight) && weight > 0))
			throw new RangeError(`Not a goal weight: ${weight}`);
	}
	return goal;
}

/** The goal in `unit`, its weights converted and not rounded. */
function asUnit(goal: WeightGoal, unit: WeightUnit): WeightGoal {
	return {
		...goal,
		unit,
		startWeight: convertWeight(goal.startWeight, goal.unit, unit),
		targetWeight: convertWeight(goal.targetWeight, goal.unit, unit)
	};
}

/** Milestones converted from `from` into `unit`, rounded. */
function milestonesAs(list: readonly Milestone[], from: WeightUnit, unit: WeightUnit): Milestone[] {
	return list.map(({ day, weight }) => ({ day, weight: round(convertWeight(weight, from, unit)) }));
}

/** Whether the goal loses, gains or holds weight. */
export function directionOf(goal: WeightGoal): Direction {
	if (goal.targetWeight < goal.startWeight) return 'loss';
	if (goal.targetWeight > goal.startWeight) return 'gain';
	return 'maintain';
}

/** The line's weight on `day`, unrounded: straight between the two dates, flat outside them. */
function lineAt(goal: WeightGoal, day: IsoDate): number {
	const span = daysBetween(goal.startOn, goal.targetOn);
	const n = Math.min(Math.max(daysBetween(goal.startOn, day), 0), span);
	return goal.startWeight + ((goal.targetWeight - goal.startWeight) * n) / span;
}

/** The goal line on `day`, in the goal's unit, rounded to 2 decimals. */
export function goalLine(goal: WeightGoal, day: IsoDate): number {
	return round(lineAt(checked(goal), day));
}

/**
 * How far the trend has gone in the goal's direction past the line: positive when ahead, negative
 * when behind. A maintain goal's progress is minus its gap, so it is never ahead.
 */
function progressOf(direction: Direction, trend: number, line: number): number {
	if (direction === 'loss') return round(line - trend);
	if (direction === 'gain') return round(trend - line);
	return round(-Math.abs(trend - line));
}

/** On track within TOLERANCE of the line; ahead beyond it in the goal's direction; otherwise behind. */
function verdictOf(
	direction: Direction,
	trend: number,
	line: number,
	unit: WeightUnit
): GoalVerdict {
	const tolerance = TOLERANCE[unit];
	if (round(Math.abs(trend - line)) <= tolerance) return 'on_track';
	return progressOf(direction, trend, line) > tolerance ? 'ahead' : 'behind';
}

/** Whether a weigh-in exists on or after the start less WEIGHIN_LOOKBACK_DAYS. */
function hasWeighIn(goal: WeightGoal, series: readonly TrendDay[]): boolean {
	const since = addDays(goal.startOn, -WEIGHIN_LOOKBACK_DAYS);
	return series.some((point) => point.weight !== null && point.day >= since);
}

/** The same day of the month, `months` later; a day the month lacks falls to its last day. */
function monthsAfter(date: IsoDate, months: number): IsoDate {
	const index = Number(date.slice(5, 7)) - 1 + months;
	const year = Number(date.slice(0, 4)) + Math.floor(index / 12);
	const month = (index % 12) + 1;
	// Day 0 of the next month is the last day of this one.
	const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
	const day = Math.min(Number(date.slice(8, 10)), lastDay);
	return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Weight milestones: each multiple of `step` strictly between the weights, dated where the line reaches it. */
function byWeight(goal: WeightGoal, step: number): Milestone[] {
	if (!(Number.isFinite(step) && step > 0)) throw new RangeError(`Not a milestone step: ${step}`);
	const span = daysBetween(goal.startOn, goal.targetOn);
	const low = round(Math.min(goal.startWeight, goal.targetWeight));
	const high = round(Math.max(goal.startWeight, goal.targetWeight));
	const weights: number[] = [];
	for (let k = Math.floor(low / step); k <= Math.ceil(high / step); k++) {
		const weight = round(k * step);
		if (weight > low && weight < high) weights.push(weight);
	}
	// From the start toward the target: a loss runs down, a gain runs up.
	if (directionOf(goal) === 'loss') weights.reverse();
	const milestones: Milestone[] = [];
	let last = goal.startOn;
	for (const weight of weights) {
		const offset = Math.round(
			((weight - goal.startWeight) / (goal.targetWeight - goal.startWeight)) * span
		);
		const day = addDays(goal.startOn, offset);
		// Days run in step with the weights, so a day that repeats or falls outside the goal is dropped.
		if (day > last && day < goal.targetOn) {
			milestones.push({ day, weight });
			last = day;
		}
	}
	return milestones;
}

/** Month milestones: each monthly anniversary of the start before the target, weighted by the line. */
function byMonth(goal: WeightGoal): Milestone[] {
	const milestones: Milestone[] = [];
	let months = 1;
	let day = monthsAfter(goal.startOn, months);
	while (day < goal.targetOn) {
		milestones.push({ day, weight: goalLine(goal, day) });
		// Past the cap is already a refusal; stop generating here.
		if (milestones.length > MILESTONES_MAX) break;
		months++;
		day = monthsAfter(goal.startOn, months);
	}
	return milestones;
}

/**
 * The milestones for the goal, every one strictly between its start and target, with one per day.
 * `too_many` when more than MILESTONES_MAX would be generated.
 */
export function generateMilestones(goal: WeightGoal, by: MilestoneBy): GeneratedMilestones {
	const checkedGoal = checked(goal);
	const milestones = by.kind === 'weight' ? byWeight(checkedGoal, by.step) : byMonth(checkedGoal);
	if (milestones.length > MILESTONES_MAX) return { ok: false, reason: 'too_many' };
	return { ok: true, milestones };
}

/**
 * The problems with an edited list of milestones, in the goal's unit: a day not strictly between
 * the start and the target, a day used twice (the later one is named), a weight outside
 * BODY_WEIGHT_RANGE, and more than MILESTONES_MAX. Empty when the list is valid.
 */
export function validateMilestones(goal: WeightGoal, list: readonly Milestone[]): MilestoneIssue[] {
	const checkedGoal = checked(goal);
	const [min, max] = BODY_WEIGHT_RANGE[checkedGoal.unit]!;
	const issues: MilestoneIssue[] = [];
	const seen = new Set<IsoDate>();
	list.forEach(({ day, weight }, index) => {
		if (!(day > checkedGoal.startOn && day < checkedGoal.targetOn)) {
			issues.push({ index, problem: 'outside_goal' });
		}
		if (seen.has(day)) issues.push({ index, problem: 'same_day' });
		seen.add(day);
		if (!(Number.isFinite(weight) && weight >= min && weight <= max)) {
			issues.push({ index, problem: 'weight_out_of_range' });
		}
	});
	if (list.length > MILESTONES_MAX) issues.push({ index: null, problem: 'too_many' });
	return issues;
}

/**
 * The weight on `day` of the piecewise path through `points` (sorted by day, start first, target
 * last), held flat outside its ends. A segment with no length reads its later point.
 */
function pathAt(points: readonly Milestone[], day: IsoDate): number {
	const first = points[0]!;
	const last = points[points.length - 1]!;
	const at = day < first.day ? first.day : day > last.day ? last.day : day;
	for (let i = 1; i < points.length; i++) {
		const from = points[i - 1]!;
		const to = points[i]!;
		if (at <= to.day) {
			const span = daysBetween(from.day, to.day);
			if (span === 0) return to.weight;
			return from.weight + ((to.weight - from.weight) * daysBetween(from.day, at)) / span;
		}
	}
	return last.weight;
}

/** The goal's status today against the trend and the line. */
export function goalStatus(
	goal: WeightGoal,
	series: readonly TrendDay[],
	today: IsoDate,
	unit: WeightUnit,
	milestones: readonly Milestone[] = []
): GoalStatus {
	const g = asUnit(checked(goal), unit);
	const reading = trendOn(series, today);
	if (reading === null || !hasWeighIn(g, series)) return { verdict: 'no_data' };
	const { trend } = reading;
	const direction = directionOf(g);
	const line = goalLine(g, today);
	const verdict = verdictOf(direction, trend, line, unit);
	const percentDone =
		direction === 'maintain'
			? verdict === 'on_track'
				? 100
				: 0
			: Math.min(
					100,
					Math.max(0, round(((g.startWeight - trend) / (g.startWeight - g.targetWeight)) * 100))
				);
	const distanceLeft = round(
		direction === 'loss'
			? Math.max(0, trend - g.targetWeight)
			: direction === 'gain'
				? Math.max(0, g.targetWeight - trend)
				: Math.abs(trend - g.targetWeight)
	);
	const listed = milestonesAs(milestones, goal.unit, unit).sort(byDay);
	return {
		verdict,
		trend,
		line,
		gap: round(Math.abs(trend - line)),
		requiredRate:
			today > g.targetOn
				? null
				: round(((g.targetWeight - trend) / Math.max(1, daysBetween(today, g.targetOn))) * 7),
		actualRate: weeklyRate(series, addDays(today, 1 - ACTUAL_RATE_DAYS), today),
		percentDone,
		distanceLeft,
		daysLeft: Math.max(0, daysBetween(today, g.targetOn)),
		nextMilestone: listed.find((milestone) => milestone.day >= today) ?? null,
		stale: reading.stale
	};
}

/** Whether a trend `trend` on a passed milestone's day is within TOLERANCE of it, or beyond it. */
function hitOf(direction: Direction, trend: number, weight: number, unit: WeightUnit): boolean {
	const difference = round(trend - weight);
	if (Math.abs(difference) <= TOLERANCE[unit]) return true;
	if (direction === 'loss') return difference < 0;
	if (direction === 'gain') return difference > 0;
	return false;
}

/**
 * Each milestone's state, oldest first, in the unit asked for. A milestone before today is hit or
 * missed on the trend of its day (missed when the series has no trend that day). A milestone on or
 * after today is judged with today's trend against the path through the start, the milestones and
 * the target at today, so every upcoming milestone shares one verdict. `no_data` for those when
 * there is no goal data today.
 */
export function milestoneStatus(
	goal: WeightGoal,
	milestones: readonly Milestone[],
	series: readonly TrendDay[],
	today: IsoDate,
	unit: WeightUnit
): MilestoneReading[] {
	const g = asUnit(checked(goal), unit);
	const direction = directionOf(g);
	const listed = milestonesAs(milestones, goal.unit, unit).sort(byDay);
	const path = [
		{ day: g.startOn, weight: g.startWeight },
		...listed,
		{ day: g.targetOn, weight: g.targetWeight }
	];
	const now = trendOn(series, today);
	const trendToday = now !== null && hasWeighIn(g, series) ? now.trend : null;
	const pathToday = pathAt(path, today);
	return listed.map(({ day, weight }) => {
		if (day >= today) {
			const status: MilestoneState =
				trendToday === null ? 'no_data' : verdictOf(direction, trendToday, pathToday, unit);
			return { day, weight, status };
		}
		const then = trendOn(series, day);
		const hit = then !== null && hitOf(direction, then.trend, weight, unit);
		return { day, weight, status: hit ? 'hit' : 'missed' };
	});
}

/**
 * The nutrition phase a goal suggests: a loss suggests cut, a gain suggests bulk, and a maintain
 * suggests nothing. Null too when the current phase already matches the suggestion.
 */
export function phaseSuggestion(
	direction: Direction,
	currentPhase: NutritionPhase | null
): 'cut' | 'bulk' | null {
	const suggested = direction === 'loss' ? 'cut' : direction === 'gain' ? 'bulk' : null;
	return suggested === null || suggested === currentPhase ? null : suggested;
}
