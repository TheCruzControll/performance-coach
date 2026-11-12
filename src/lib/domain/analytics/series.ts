/**
 * Series and summary statistics for every M6 figure: grouping dated values into days, weeks and
 * months, filling the weeks of a period, robust statistics, and comparing a period with the one
 * before or the week in progress with the same days of last week.
 *
 * - Weeks are M3's (weekStartOf: the Monday of the owner's week, in the profile's time zone), so
 *   these figures line up with hard sets and weekly distance.
 * - A point in progress (today's week, periods.ts) is carried on the series so a chart can mark
 *   it 'so far', but totals, averages and rolling medians never use it.
 * - A gap (null) is no data, which is not zero: fill 'zero' only what is a count of nothing (no
 *   sets lifted is 0 kg), and 'gap' what has no value without data (an average RPE).
 * - A comparison never invents a previous value: with no data, or nothing, before, it is null.
 *
 * Conventions for src/lib/domain/analytics (M6): pure (no I/O, clock or randomness), imported by
 * path (no index file), no zod, no runtime import of domain/programming or domain/exercises.
 * Server-only at runtime: only the modules listed in scripts/analytics-client-imports.test.ts are
 * client-safe, and this is not one; screens receive its results.
 */
import { addDays, mondayOf, weekdayOf } from '../calendar.ts';
import type { IsoDate } from '../calendar.ts';
import { localDay } from '../dates.ts';
import { weekStartIn } from '../training/metrics.ts';
import { cleanFloat } from '../units.ts';
import { sameDaysLastWeek, weekStarts } from './periods.ts';
import type { DayRange, InProgressWeek, WeekRange } from './periods.ts';
import type { Comparison, Direction, SeriesPoint } from './types.ts';

/** A value at an instant (a set's tonnage when it was performed, a run's metres when it started). */
export interface Timed {
	at: Date;
	value: number;
}

/** How a bucket's values become one: total for counts and amounts, mean or median for levels. */
export type Reduce = (values: readonly number[]) => number | null;

// ---- Summary statistics ---------------------------------------------------------------------

/** cleanFloat, with −0 read as 0 so a difference of nothing compares and prints as 0. */
const clean = (value: number) => cleanFloat(value) + 0;

function finite(values: readonly number[]): readonly number[] {
	const bad = values.find((value) => !Number.isFinite(value));
	if (bad !== undefined) throw new RangeError(`Not a finite number: ${bad}`);
	return values;
}

/** The sum, free of floating-point noise; null for no values. */
export const total: Reduce = (values) =>
	finite(values).length === 0 ? null : clean(values.reduce((sum, value) => sum + value, 0));

/** The arithmetic mean, free of floating-point noise; null for no values. */
export function mean(values: readonly number[]): number | null {
	if (finite(values).length === 0) return null;
	// Summed as offsets from the first value, so a constant series has its own value as its mean.
	const first = values[0]!;
	return clean(first + values.reduce((sum, value) => sum + (value - first), 0) / values.length);
}

/** The middle value, or the mean of the two middle values for an even count; null for none. */
export function median(values: readonly number[]): number | null {
	if (finite(values).length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[middle]!;
	return clean((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/**
 * The median absolute deviation from the median, unscaled (× 1.4826 estimates a normal SD). Robust
 * to an outlier, where sd is not. 0 for a constant series; null for no values.
 */
export function mad(values: readonly number[]): number | null {
	const centre = median(values);
	if (centre === null) return null;
	return median(values.map((value) => Math.abs(value - centre)));
}

/** The sample standard deviation (n − 1). Exactly 0 for a constant series; null under 2 values. */
export function sd(values: readonly number[]): number | null {
	if (finite(values).length < 2) return null;
	// Shifted by the first value: exact for a constant series, and stable for large values.
	const first = values[0]!;
	let sum = 0;
	let squares = 0;
	for (const value of values) {
		sum += value - first;
		squares += (value - first) ** 2;
	}
	const variance = (squares - sum ** 2 / values.length) / (values.length - 1);
	return Math.sqrt(Math.max(0, variance));
}

// ---- Grouping -------------------------------------------------------------------------------

function group(
	values: readonly Timed[],
	keyOf: (at: Date) => IsoDate,
	reduce: Reduce
): Map<IsoDate, number> {
	const groups = new Map<IsoDate, number[]>();
	for (const { at, value } of values) {
		const key = keyOf(at);
		const bucket = groups.get(key);
		if (bucket) bucket.push(value);
		else groups.set(key, [value]);
	}
	const reduced = new Map<IsoDate, number>();
	for (const key of [...groups.keys()].sort()) {
		const value = reduce(groups.get(key)!);
		if (value !== null) reduced.set(key, value);
	}
	return reduced;
}

/** Values by the owner's calendar day (localDay), in day order; summed unless told otherwise. */
export function byDay(
	values: readonly Timed[],
	timeZone: string,
	reduce: Reduce = total
): Map<IsoDate, number> {
	return group(values, (at) => localDay(at, timeZone), reduce);
}

/** Values by the Monday of the owner's week (M3's weekStartOf), in week order; summed by default. */
export function byWeek(
	values: readonly Timed[],
	timeZone: string,
	reduce: Reduce = total
): Map<IsoDate, number> {
	return group(values, weekStartIn(timeZone), reduce);
}

/**
 * Items by the Monday of their day's week, each week's in the order given, so each week of a long
 * period reads its own items instead of filtering all of them. Each day's Monday is worked out once.
 */
export function byMonday<T>(items: readonly T[], dayOf: (item: T) => IsoDate): Map<IsoDate, T[]> {
	return Map.groupBy(items, (item) => mondayOfDay(dayOf(item)));
}

/**
 * Each day's Monday once worked out, for every request: the figures ask for the week of every
 * fact, over a few thousand days. Emptied once it holds MONDAY_MEMO_MAX days. (This module is
 * server-only, so the memo costs no route its JavaScript.)
 */
const MONDAY_MEMO_MAX = 10_000;
const mondays = new Map<IsoDate, IsoDate>();
export function mondayOfDay(day: IsoDate): IsoDate {
	let monday = mondays.get(day);
	if (monday === undefined) {
		if (mondays.size >= MONDAY_MEMO_MAX) mondays.clear();
		mondays.set(day, (monday = mondayOf(day)));
	}
	return monday;
}

/** How fillWeeks marks a week with no value: 0 (a count of nothing) or null (a gap). */
export type Fill = 'zero' | 'gap';

/**
 * One point for each complete week of `weeks`, from `byWeek`'s buckets, then the week in progress
 * when given, marked so. A week with no bucket is 0 or a gap by `fill`.
 */
export function fillWeeks(
	buckets: ReadonlyMap<IsoDate, number>,
	weeks: WeekRange | null,
	fill: Fill,
	inProgress?: InProgressWeek
): SeriesPoint[] {
	const empty = fill === 'zero' ? 0 : null;
	const point = (at: IsoDate, open: boolean) => ({
		at,
		value: buckets.get(at) ?? empty,
		inProgress: open
	});
	const points = weekStarts(weeks).map((at) => point(at, false));
	return inProgress ? [...points, point(inProgress.weekStart, true)] : points;
}

/**
 * Weekly points regrouped by month, for periods long enough to bucket by month (periods.ts). Each
 * week belongs to the month its Thursday falls in, as ISO weeks belong to years, so a month holds
 * 4 or 5 whole weeks and no week is split or counted twice. A month's value is its weeks' mean by
 * default, so the axis keeps weekly units and 4- and 5-week months compare fairly; pass total
 * for a monthly sum. Gaps are left out (a month of gaps is a gap). The point in progress is
 * kept apart, after the months, unchanged. Throws RangeError for a point that is not a Monday.
 */
export function byMonth(points: readonly SeriesPoint[], reduce: Reduce = mean): SeriesPoint[] {
	const months = new Map<IsoDate, number[]>();
	for (const { at, value, inProgress } of points) {
		if (weekdayOf(at) !== 'mon') throw new RangeError(`Not a weekly point (a Monday): ${at}`);
		if (inProgress) continue;
		const month = `${addDays(at, 3).slice(0, 7)}-01`;
		months.set(month, [...(months.get(month) ?? []), ...(value === null ? [] : [value])]);
	}
	const monthly = [...months].map(([at, values]) => ({
		at,
		value: values.length === 0 ? null : reduce(values),
		inProgress: false
	}));
	return [...monthly, ...points.filter((point) => point.inProgress)];
}

// ---- Series summaries -----------------------------------------------------------------------

/** The values that count in a summary: complete points that have one. */
const counted = (points: readonly SeriesPoint[]) =>
	points.flatMap(({ value, inProgress }) => (inProgress || value === null ? [] : [value]));

/** The sum of a series' complete points, gaps and the point in progress left out; null for none. */
export function totalOf(points: readonly SeriesPoint[]): number | null {
	return total(counted(points));
}

/**
 * The mean of a series' complete points, gaps and the point in progress left out; null for none.
 * Zero-filled weeks count, so a weekly series gives the average week.
 */
export function averageOf(points: readonly SeriesPoint[]): number | null {
	return mean(counted(points));
}

/**
 * Each point's median over the `window` complete points ending at it, gaps left out of the
 * median. Null until `window` complete points have passed, for a window of gaps only, and for the
 * point in progress, which no window includes. Throws RangeError unless `window` is a whole
 * number of at least 1.
 */
export function rollingMedian(points: readonly SeriesPoint[], window: number): SeriesPoint[] {
	if (!Number.isInteger(window) || window < 1) {
		throw new RangeError(`A window is a whole number of points, at least 1: ${window}`);
	}
	const complete: (number | null)[] = [];
	return points.map((point) => {
		if (point.inProgress) return { ...point, value: null };
		complete.push(point.value);
		if (complete.length < window) return { ...point, value: null };
		const values = complete.slice(-window).filter((value) => value !== null);
		return { ...point, value: median(values) };
	});
}

// ---- Comparisons ----------------------------------------------------------------------------

const NOTHING_TO_COMPARE: Comparison = { delta: null, pct: null, change: null };

/**
 * `current` against `previous`: the difference, the percentage of the previous value's size, and
 * whether that is better or worse by the metric's `direction`.
 *
 * All null when there is nothing to compare with: no current or previous value, or a previous
 * value of 0. A previous total of 0 is a period with nothing in it (often weeks before the owner
 * began, zero-filled), and '+20 km on nothing' or '+∞ %' would invent a comparison. A current 0
 * against a real previous value is a real fall. Throws RangeError for NaN or an infinity.
 */
export function compare(
	current: number | null,
	previous: number | null,
	direction: Direction
): Comparison {
	finite([current ?? 0, previous ?? 0]);
	if (current === null || previous === null || previous === 0) return NOTHING_TO_COMPARE;
	const delta = clean(current - previous);
	const pct = clean((delta / Math.abs(previous)) * 100);
	return { delta, pct, change: changeOf(delta, direction) };
}

function changeOf(delta: number, direction: Direction): Comparison['change'] {
	if (delta === 0) return 'same';
	if (direction === 'none') return delta > 0 ? 'up' : 'down';
	return delta > 0 === (direction === 'up') ? 'better' : 'worse';
}

export interface SoFar extends Comparison {
	/** The week in progress so far; null when nothing is logged yet. */
	value: number | null;
	/** The same days of last week; null when nothing was logged then. */
	lastWeek: number | null;
	/** Last week's days that `lastWeek` covers: Monday to today's weekday a week ago. */
	lastWeekDays: DayRange;
}

/**
 * The like-for-like line for the week in progress ('This week so far: 6,200 kg · 5,900 kg by
 * Wednesday last week'): `values` on this week's days so far against `values` on the same days of
 * last week (sameDaysLastWeek), each reduced (summed by default) and compared. Values on other
 * days, last Thursday's included on a Wednesday, are ignored.
 */
export function soFar(
	values: readonly Timed[],
	inProgress: InProgressWeek,
	options: { timeZone: string; direction: Direction; reduce?: Reduce }
): SoFar {
	const { timeZone, direction, reduce = total } = options;
	const lastWeekDays = sameDaysLastWeek(inProgress);
	const within = (from: IsoDate, through: IsoDate) => {
		const days = values.filter(({ at }) => {
			const day = localDay(at, timeZone);
			return day >= from && day <= through;
		});
		return days.length === 0 ? null : reduce(days.map(({ value }) => value));
	};
	const value = within(inProgress.weekStart, inProgress.through);
	const lastWeek = within(lastWeekDays.from, lastWeekDays.through);
	return { value, lastWeek, lastWeekDays, ...compare(value, lastWeek, direction) };
}
