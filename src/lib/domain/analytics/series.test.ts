import { describe, expect, it } from 'vitest';
import { periodWindow } from './periods';
import {
	averageOf,
	byDay,
	byMonth,
	byWeek,
	compare,
	fillWeeks,
	mad,
	mean,
	median,
	rollingMedian,
	sd,
	soFar,
	total,
	totalOf
} from './series';
import type { Timed } from './series';
import type { SeriesPoint } from './types';

const LA = 'America/Los_Angeles';
const WEDNESDAY = '2026-11-04';
const at = (instant: string, value: number): Timed => ({ at: new Date(instant), value });
const week = (monday: string, value: number | null, inProgress = false): SeriesPoint => ({
	at: monday,
	value,
	inProgress
});
/** Complete weekly points from `values`, Mondays from 5 October 2026. */
const weekly = (values: (number | null)[]) =>
	values.map((value, n) =>
		week(new Date(Date.UTC(2026, 9, 5 + 7 * n)).toISOString().slice(0, 10), value)
	);

describe('summary statistics', () => {
	it('gives the mean, median, MAD and SD of known series', () => {
		expect(mean([1, 2, 3, 4])).toBe(2.5);
		expect(mean([0.1, 0.2])).toBe(0.15);
		expect(median([5, 1, 3])).toBe(3);
		expect(median([4, 1, 3, 2])).toBe(2.5);
		// Median 2; deviations 1, 1, 0, 0, 2, 4, 7, whose median is 1.
		expect(mad([1, 1, 2, 2, 4, 6, 9])).toBe(1);
		expect(sd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.13809, 5);
		expect(total([5.1, 5.2])).toBe(10.3);
	});

	it('gives a MAD and an SD of exactly 0 for a constant series', () => {
		for (const value of [80.1, 0.1, 1e9 + 0.3, -3.7]) {
			const constant = Array.from({ length: 9 }, () => value);
			expect(mad(constant), String(value)).toBe(0);
			expect(sd(constant), String(value)).toBe(0);
			expect(mean(constant), String(value)).toBe(value);
			expect(median(constant), String(value)).toBe(value);
		}
	});

	it('keeps the MAD robust to one outlier, where the SD is not', () => {
		const steady = [100, 101, 99, 100, 102, 98, 100];
		const spiked = [...steady.slice(0, -1), 400];
		expect(mad(spiked)).toBe(mad(steady));
		expect(sd(spiked)!).toBeGreaterThan(10 * sd(steady)!);
	});

	it('gives null without enough values: none at all, or one for the SD', () => {
		expect(mean([])).toBeNull();
		expect(median([])).toBeNull();
		expect(mad([])).toBeNull();
		expect(total([])).toBeNull();
		expect(sd([])).toBeNull();
		expect(sd([7])).toBeNull();
	});

	it('throws RangeError for NaN or an infinity rather than return one', () => {
		for (const fn of [mean, median, mad, sd, total]) {
			expect(() => fn([1, Number.NaN])).toThrow(RangeError);
			expect(() => fn([1, Number.POSITIVE_INFINITY])).toThrow(RangeError);
		}
	});
});

describe('grouping', () => {
	const values = [
		// Sunday 1 November, 21:00 in Los Angeles but already Monday in UTC: still the week of 26 October.
		at('2026-11-02T05:00:00Z', 100),
		at('2026-10-27T18:00:00Z', 50),
		at('2026-10-27T19:00:00Z', 25),
		// Monday 2 November in Los Angeles.
		at('2026-11-02T17:00:00Z', 10)
	];

	it("groups by the owner's week through M3's weekStartOf, summing by default", () => {
		expect([...byWeek(values, LA)]).toEqual([
			['2026-10-26', 175],
			['2026-11-02', 10]
		]);
		expect([...byWeek(values, 'UTC')]).toEqual([
			['2026-10-26', 75],
			['2026-11-02', 110]
		]);
	});

	it("groups by the owner's day, in day order", () => {
		expect([...byDay(values, LA)]).toEqual([
			['2026-10-27', 75],
			['2026-11-01', 100],
			['2026-11-02', 10]
		]);
	});

	it('reduces a bucket as told: a mean, a median or a best', () => {
		expect(byWeek(values, LA, mean).get('2026-10-26')).toBeCloseTo(58.333333, 6);
		expect(byWeek(values, LA, median).get('2026-10-26')).toBe(50);
		expect(byWeek(values, LA, (v) => Math.max(...v)).get('2026-10-26')).toBe(100);
		expect(byWeek([], LA).size).toBe(0);
	});
});

describe('fillWeeks', () => {
	const window = periodWindow(WEDNESDAY, '4w', null);
	const buckets = new Map([
		['2026-09-28', 999], // before the period: ignored
		['2026-10-05', 1000],
		['2026-10-19', 1200],
		['2026-11-02', 300] // the week in progress
	]);

	it('zero-fills the weeks without a bucket, one point per complete week', () => {
		expect(fillWeeks(buckets, window.weeks, 'zero')).toEqual([
			week('2026-10-05', 1000),
			week('2026-10-12', 0),
			week('2026-10-19', 1200),
			week('2026-10-26', 0)
		]);
	});

	it('leaves gaps as null when told to, which is not zero', () => {
		expect(fillWeeks(buckets, window.weeks, 'gap').map((p) => p.value)).toEqual([
			1000,
			null,
			1200,
			null
		]);
	});

	it('adds the week in progress last, marked so, only when given', () => {
		const points = fillWeeks(buckets, window.weeks, 'zero', window.inProgress);
		expect(points).toHaveLength(5);
		expect(points.at(-1)).toEqual(week('2026-11-02', 300, true));
		expect(points.filter((p) => p.inProgress)).toHaveLength(1);
		expect(fillWeeks(new Map(), window.weeks, 'gap', window.inProgress).at(-1)).toEqual(
			week('2026-11-02', null, true)
		);
	});

	it('gives only the week in progress when there are no complete weeks', () => {
		const first = periodWindow(WEDNESDAY, 'all', WEDNESDAY);
		expect(fillWeeks(buckets, first.weeks, 'zero', first.inProgress)).toEqual([
			week('2026-11-02', 300, true)
		]);
		expect(fillWeeks(buckets, first.weeks, 'zero')).toEqual([]);
	});
});

describe('byMonth', () => {
	// Mondays 28 September to 2 November 2026; 28 September's Thursday is 1 October.
	const points = [
		week('2026-09-21', 10),
		week('2026-09-28', 20),
		week('2026-10-05', 30),
		week('2026-10-12', null),
		week('2026-10-19', 50),
		week('2026-10-26', 60),
		week('2026-11-02', 5, true)
	];

	it("puts each week in its Thursday's month and averages its weeks, gaps left out", () => {
		expect(byMonth(points)).toEqual([
			week('2026-09-01', 10),
			// 28 September, 5, 19 and 26 October; 12 October is a gap.
			week('2026-10-01', 40),
			week('2026-11-02', 5, true)
		]);
	});

	it('sums the weeks when told to', () => {
		expect(byMonth(points, total).map((p) => p.value)).toEqual([10, 160, 5]);
	});

	it('counts every week once, in one month', () => {
		const year = weekly(Array.from({ length: 52 }, () => 1));
		const months = byMonth(year, total);
		expect(totalOf(months)).toBe(52);
		expect(months.every((m) => m.value === 4 || m.value === 5)).toBe(true);
	});

	it('gives a gap for a month of gaps, and keeps the week in progress apart', () => {
		const gaps = [week('2026-10-05', null), week('2026-10-12', null), week('2026-11-02', 7, true)];
		expect(byMonth(gaps)).toEqual([week('2026-10-01', null), week('2026-11-02', 7, true)]);
	});

	it('throws RangeError for a point that is not weekly', () => {
		expect(() => byMonth([week('2026-10-07', 1)])).toThrow(RangeError);
	});
});

describe('totals and averages', () => {
	it('skip the point in progress and gaps', () => {
		const points = [...weekly([100, null, 300, 0]), week('2026-11-02', 5000, true)];
		expect(totalOf(points)).toBe(400);
		// Zero-filled weeks count toward the average week; gaps do not.
		expect(averageOf(points)).toBeCloseTo(133.333333, 6);
	});

	it('give null with nothing to count, the point in progress alone included', () => {
		expect(totalOf([])).toBeNull();
		expect(averageOf(weekly([null, null]))).toBeNull();
		expect(totalOf([week('2026-11-02', 5000, true)])).toBeNull();
		expect(averageOf([week('2026-11-02', 5000, true)])).toBeNull();
	});
});

describe('rollingMedian', () => {
	const values = (points: SeriesPoint[]) => points.map((p) => p.value);

	it('takes the median of an odd window, null until the window is full', () => {
		expect(values(rollingMedian(weekly([5, 1, 9, 3, 7]), 3))).toEqual([null, null, 5, 3, 7]);
	});

	it('takes the mean of the two middle values for an even window', () => {
		expect(values(rollingMedian(weekly([5, 1, 9, 3, 7]), 4))).toEqual([null, null, null, 4, 5]);
	});

	it('gives only nulls when the series is shorter than the window', () => {
		expect(values(rollingMedian(weekly([5, 1]), 3))).toEqual([null, null]);
		expect(rollingMedian([], 3)).toEqual([]);
	});

	it('is the series itself for a window of 1, gaps staying gaps', () => {
		expect(values(rollingMedian(weekly([5, null, 9]), 1))).toEqual([5, null, 9]);
	});

	it('leaves gaps out of a window, and a window of gaps is a gap', () => {
		expect(values(rollingMedian(weekly([5, null, 9, null, null, null]), 3))).toEqual([
			null,
			null,
			7,
			9,
			9,
			null
		]);
	});

	it('never puts the point in progress in a window, and gives it no value', () => {
		const points = [...weekly([5, 1, 9]), week('2026-11-02', 1000, true)];
		const rolled = rollingMedian(points, 3);
		expect(values(rolled)).toEqual([null, null, 5, null]);
		expect(rolled.map((p) => [p.at, p.inProgress])).toEqual(
			points.map((p) => [p.at, p.inProgress])
		);
	});

	it.each([0, -1, 1.5, Number.NaN])('throws RangeError for a window of %d', (window) => {
		expect(() => rollingMedian(weekly([1, 2, 3]), window)).toThrow(RangeError);
	});
});

describe('compare', () => {
	it('gives the delta, the percentage and the change by direction', () => {
		expect(compare(6200, 5900, 'up')).toEqual({ delta: 300, pct: 5.084746, change: 'better' });
		expect(compare(5600, 5900, 'up')).toEqual({ delta: -300, pct: -5.084746, change: 'worse' });
		// A pace in s/km: lower is better.
		expect(compare(290, 300, 'down')).toEqual({ delta: -10, pct: -3.333333, change: 'better' });
		expect(compare(310, 300, 'down')).toEqual({ delta: 10, pct: 3.333333, change: 'worse' });
		expect(compare(81, 80, 'none')).toEqual({ delta: 1, pct: 1.25, change: 'up' });
		expect(compare(79, 80, 'none')).toEqual({ delta: -1, pct: -1.25, change: 'down' });
		expect(compare(80, 80, 'up')).toEqual({ delta: 0, pct: 0, change: 'same' });
	});

	it('is free of floating-point noise, so equal sums read as the same', () => {
		expect(compare(0.1 + 0.2, 0.3, 'up')).toEqual({ delta: 0, pct: 0, change: 'same' });
		// The other way round the noise is negative: still 0, never −0.
		expect(compare(0.3, 0.1 + 0.2, 'up')).toEqual({ delta: 0, pct: 0, change: 'same' });
	});

	it('takes the percentage of a negative previous value by its size', () => {
		// Mean RPE 0.5 above target, from 1 below: up by 150 % of the earlier size.
		expect(compare(0.5, -1, 'none')).toEqual({ delta: 1.5, pct: 150, change: 'up' });
	});

	it('gives null deltas for an empty or zero previous period, never NaN or Infinity', () => {
		const none = { delta: null, pct: null, change: null };
		expect(compare(6200, null, 'up')).toEqual(none);
		expect(compare(6200, 0, 'up')).toEqual(none);
		expect(compare(0, 0, 'up')).toEqual(none);
		expect(compare(null, 5900, 'up')).toEqual(none);
		expect(compare(null, null, 'down')).toEqual(none);
	});

	it('reads a current 0 against a real previous value as a fall', () => {
		expect(compare(0, 5900, 'up')).toEqual({ delta: -5900, pct: -100, change: 'worse' });
	});

	it('never gives NaN or Infinity, for any pair', () => {
		const samples = [null, 0, -0, 1e-12, -2.5, 3, 1e12];
		for (const current of samples) {
			for (const previous of samples) {
				const { delta, pct } = compare(current, previous, 'up');
				for (const value of [delta, pct]) {
					expect(value === null || Number.isFinite(value), `${current} vs ${previous}`).toBe(true);
				}
			}
		}
	});

	it('throws RangeError for NaN or an infinity', () => {
		expect(() => compare(Number.NaN, 1, 'up')).toThrow(RangeError);
		expect(() => compare(1, Number.POSITIVE_INFINITY, 'up')).toThrow(RangeError);
	});
});

describe('soFar', () => {
	const { inProgress } = periodWindow(WEDNESDAY, '12w', null);
	// Instants in Los Angeles (UTC−8 in November, −7 before 1 November).
	const values = [
		at('2026-11-02T17:00:00Z', 3000), // Monday this week
		at('2026-11-04T17:00:00Z', 3200), // Wednesday this week
		at('2026-10-26T17:00:00Z', 2500), // last Monday
		at('2026-10-29T03:00:00Z', 3400), // last Wednesday, 20:00 (Thursday in UTC)
		at('2026-10-29T17:00:00Z', 4000), // last Thursday: after the same days
		at('2026-11-01T18:00:00Z', 5000), // last Sunday
		at('2026-10-25T18:00:00Z', 9000) // the week before
	];

	it('compares the week so far with the same days of last week, and nothing else', () => {
		expect(soFar(values, inProgress, { timeZone: LA, direction: 'up' })).toEqual({
			value: 6200,
			lastWeek: 5900,
			lastWeekDays: { from: '2026-10-26', through: '2026-10-28', days: 3 },
			delta: 300,
			pct: 5.084746,
			change: 'better'
		});
	});

	it("reads each value on the owner's day, not UTC's", () => {
		// In UTC, last Wednesday's 3,400 falls on Thursday, outside the same days.
		expect(soFar(values, inProgress, { timeZone: 'UTC', direction: 'up' }).lastWeek).toBe(2500);
	});

	it('reduces as told', () => {
		const result = soFar(values, inProgress, { timeZone: LA, direction: 'up', reduce: mean });
		expect([result.value, result.lastWeek]).toEqual([3100, 2950]);
	});

	it('gives null for a side with nothing logged, and then no comparison', () => {
		const thisWeekOnly = values.slice(0, 2);
		expect(soFar(thisWeekOnly, inProgress, { timeZone: LA, direction: 'up' })).toMatchObject({
			value: 6200,
			lastWeek: null,
			delta: null,
			pct: null,
			change: null
		});
		expect(soFar([], inProgress, { timeZone: LA, direction: 'up' })).toMatchObject({
			value: null,
			lastWeek: null,
			change: null
		});
	});

	it('on a Monday compares Monday with last Monday only', () => {
		const monday = periodWindow('2026-11-02', '12w', null).inProgress;
		const result = soFar(values, monday, { timeZone: LA, direction: 'up' });
		expect([result.value, result.lastWeek]).toEqual([3000, 2500]);
	});
});
