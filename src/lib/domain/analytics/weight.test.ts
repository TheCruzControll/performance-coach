import { describe, expect, it } from 'vitest';
import { addDays } from '../calendar';
import { cleanFloat } from '../units';
import {
	dailyTrend,
	logBook,
	STALE_DAYS,
	TOLERANCE,
	TREND_ALPHA,
	trendOn,
	type TrendDay,
	weeklyRate,
	weeklyRateBars,
	type WeighIn,
	weightStats
} from './weight';

/** A Monday, so the weeks in these tests start on the first day. */
const DAY0 = '2026-08-10';
const at = (days: number) => addDays(DAY0, days);
const kg = (day: number, value: number): WeighIn => ({ measuredOn: at(day), value, unit: 'kg' });
const lb = (day: number, value: number): WeighIn => ({ measuredOn: at(day), value, unit: 'lb' });

/**
 * `days` days from DAY0 with a trend rising half a unit a day, weighed on the days in `weighedOn`
 * (weight 80 on each). The synthetic series lets a rate be checked exactly.
 */
const rising = (days: number, weighedOn: readonly number[] = [0, 1]): TrendDay[] =>
	Array.from({ length: days }, (_, n) => ({
		day: at(n),
		weight: weighedOn.includes(n) ? 80 : null,
		filled: !weighedOn.includes(n),
		trend: 80 + 0.5 * n
	}));

describe('the trend: an exponentially smoothed average', () => {
	it('moves a tenth of the way from the trend to each day’s weight', () => {
		expect(TREND_ALPHA).toBe(0.1);
		const series = dailyTrend([kg(0, 80), kg(1, 90), kg(2, 90)], 'kg');
		// T(0) = 80; T(1) = 80 + 0.1 × 10 = 81; T(2) = 81 + 0.1 × 9 = 81.9.
		expect(series.map((point) => point.trend)).toEqual([80, 81, 81.9]);
		expect(series[0]).toEqual({ day: at(0), weight: 80, filled: false, trend: 80 });
	});

	it('fills a skipped day by linear interpolation, with no weight of its own', () => {
		const series = dailyTrend([kg(0, 80), kg(2, 82)], 'kg');
		// Day 1 is interpolated to 81: T(1) = 80 + 0.1 × 1 = 80.1; T(2) = 80.1 + 0.1 × 1.9 = 80.29.
		expect(series).toEqual([
			{ day: at(0), weight: 80, filled: false, trend: 80 },
			{ day: at(1), weight: null, filled: true, trend: 80.1 },
			{ day: at(2), weight: 82, filled: false, trend: 80.29 }
		]);
	});

	it('is not extended past the last weigh-in', () => {
		const series = dailyTrend([kg(0, 80), kg(2, 82)], 'kg');
		expect(series).toHaveLength(3);
		expect(series[series.length - 1]!.day).toBe(at(2));
	});

	it('gives weekly weigh-ins along a straight path the same trend as daily ones', () => {
		const path = (day: number) => 100 - 0.1 * day;
		const daily = dailyTrend(
			Array.from({ length: 29 }, (_, day) => kg(day, path(day))),
			'kg'
		);
		const weekly = dailyTrend(
			[0, 7, 14, 21, 28].map((day) => kg(day, path(day))),
			'kg'
		);
		expect(weekly.map((point) => point.day)).toEqual(daily.map((point) => point.day));
		daily.forEach((point, n) => {
			expect(Math.abs(weekly[n]!.trend - point.trend)).toBeLessThanOrEqual(0.01);
		});
		expect(weekly[3]).toMatchObject({ weight: null, filled: true });
	});

	it('refuses two weigh-ins on one day', () => {
		expect(() => dailyTrend([kg(0, 80), kg(0, 81)], 'kg')).toThrow(RangeError);
	});

	it('is empty with no weigh-ins', () => {
		expect(dailyTrend([], 'kg')).toEqual([]);
	});

	it('mixes kg and lb, and shows every weight in the unit asked for', () => {
		const inKg = dailyTrend([kg(0, 100), lb(1, 220.46)], 'kg');
		expect(inKg[1]!.weight).toBe(100);
		const inLb = dailyTrend([kg(0, 100), lb(1, 220.46)], 'lb');
		expect(inLb[0]!.weight).toBe(220.46);
		expect(inLb[1]!.weight).toBe(220.46);
	});
});

describe('trendOn', () => {
	const series = dailyTrend([kg(0, 80), kg(1, 81)], 'kg');

	it('is the trend on a day of the series, not stale', () => {
		expect(trendOn(series, at(0))).toEqual({ trend: 80, stale: false });
	});

	it('is held at the last trend after the last weigh-in, stale past STALE_DAYS', () => {
		expect(STALE_DAYS).toBe(7);
		expect(trendOn(series, at(8))).toEqual({ trend: 80.1, stale: false });
		expect(trendOn(series, at(9))).toEqual({ trend: 80.1, stale: true });
	});

	it('is null before the first weigh-in and with no series', () => {
		expect(trendOn(series, at(-1))).toBeNull();
		expect(trendOn([], at(0))).toBeNull();
	});
});

describe('weeklyRate', () => {
	it('is 7 × the least-squares slope of the trend', () => {
		// The trend rises 0.5 a day: 3.5 a week.
		expect(weeklyRate(rising(14, [0, 13]), at(0), at(13))).toBe(3.5);
	});

	it('is null with fewer than 7 series days', () => {
		expect(weeklyRate(rising(6), at(0), at(5))).toBeNull();
	});

	it('is null with fewer than 2 weigh-ins in the window', () => {
		expect(weeklyRate(rising(14, [0]), at(0), at(13))).toBeNull();
	});

	it('uses only the days in the window', () => {
		const series = rising(30, [0, 1, 10, 20]);
		expect(weeklyRate(series, at(10), at(20))).toBe(3.5);
		expect(weeklyRate(series, at(10), at(15))).toBeNull();
	});
});

describe('weeklyRateBars', () => {
	// Three full weeks and Thursday of a fourth, the trend rising 0.1 a day.
	const series: TrendDay[] = Array.from({ length: 25 }, (_, n) => ({
		day: at(n),
		weight: null,
		filled: true,
		trend: 80 + 0.1 * n
	}));

	it('gives one bar per Monday week, the current week so far', () => {
		expect(weeklyRateBars(series, at(24))).toEqual([
			{ week: at(0), change: null, soFar: false },
			{ week: at(7), change: 0.7, soFar: false },
			{ week: at(14), change: 0.7, soFar: false },
			{ week: at(21), change: 0.4, soFar: true }
		]);
	});

	it('skips the weeks after the last weigh-in', () => {
		const short = series.slice(0, 11);
		expect(weeklyRateBars(short, at(30))).toEqual([
			{ week: at(0), change: null, soFar: false },
			{ week: at(7), change: 0.4, soFar: false }
		]);
	});

	it('is empty with no series', () => {
		expect(weeklyRateBars([], at(0))).toEqual([]);
	});
});

describe('weightStats', () => {
	// Trend: 80, then 80.2, then 80.28.
	const entries = [kg(0, 80), kg(1, 82), kg(2, 81)];

	it('gives the latest, trend, highest, lowest, change and rate over the whole history', () => {
		expect(weightStats(entries, 'kg', { from: null, to: at(2) })).toEqual({
			latest: { day: at(2), weight: 81 },
			trend: 80.28,
			highest: { day: at(1), weight: 82 },
			lowest: { day: at(0), weight: 80 },
			change: 0.28,
			weeklyRate: null
		});
	});

	it('takes a tie for highest or lowest to the earlier weigh-in', () => {
		const stats = weightStats([kg(0, 80), kg(1, 82), kg(2, 80), kg(3, 82)], 'kg', {
			from: null,
			to: at(3)
		});
		expect(stats.highest).toEqual({ day: at(1), weight: 82 });
		expect(stats.lowest).toEqual({ day: at(0), weight: 80 });
	});

	it('measures the window from its own weigh-ins and the trend at its start', () => {
		expect(weightStats(entries, 'kg', { from: at(1), to: at(2) })).toEqual({
			latest: { day: at(2), weight: 81 },
			trend: 80.28,
			highest: { day: at(1), weight: 82 },
			lowest: { day: at(2), weight: 81 },
			// T(2) − T(1) = 80.28 − 80.2.
			change: 0.08,
			weeklyRate: null
		});
	});

	it('is all null for a window with no weigh-in, and with no entries', () => {
		const none = {
			latest: null,
			trend: null,
			highest: null,
			lowest: null,
			change: null,
			weeklyRate: null
		};
		expect(weightStats(entries, 'kg', { from: at(5), to: at(9) })).toEqual(none);
		expect(weightStats([], 'kg', { from: null, to: at(0) })).toEqual(none);
	});

	it('gives a weekly rate of 0 for a steady weight over two weeks', () => {
		const steady = Array.from({ length: 14 }, (_, n) => kg(n, 80));
		const stats = weightStats(steady, 'kg', { from: null, to: at(13) });
		expect(stats).toMatchObject({ trend: 80, change: 0, weeklyRate: 0 });
	});
});

describe('logBook', () => {
	it('gives a row per weigh-in, newest first, with the change from the one before', () => {
		expect(logBook([kg(0, 80), kg(1, 82), kg(2, 81)], 'kg')).toEqual([
			{ day: at(2), weight: 81, trend: 80.28, change: -1, weeklyRate: null },
			{ day: at(1), weight: 82, trend: 80.2, change: 2, weeklyRate: null },
			{ day: at(0), weight: 80, trend: 80, change: null, weeklyRate: null }
		]);
	});

	it('gives the weekly rate as the trend minus the trend seven days earlier, null before day 7', () => {
		const entries = Array.from({ length: 12 }, (_, n) => kg(n, 80 + 0.2 * n));
		const series = dailyTrend(entries, 'kg');
		const rows = logBook(entries, 'kg');
		for (const row of rows) {
			const index = series.findIndex((point) => point.day === row.day);
			if (index < 7) {
				expect(row.weeklyRate).toBeNull();
			} else {
				expect(row.weeklyRate).toBe(cleanFloat(series[index]!.trend - series[index - 7]!.trend, 2));
			}
		}
	});

	it('shows lb weigh-ins in the unit asked for', () => {
		// 176.37 lb is 80 kg, so the change from the 80 kg weigh-in is nothing.
		expect(logBook([kg(0, 80), lb(1, 176.37)], 'kg')).toMatchObject([
			{ day: at(1), weight: 80, change: 0 },
			{ day: at(0), weight: 80, change: null }
		]);
	});

	it('is empty with no weigh-ins', () => {
		expect(logBook([], 'kg')).toEqual([]);
	});
});

describe('TOLERANCE', () => {
	it('is half a kilogram or one pound either side of the goal line', () => {
		expect(TOLERANCE).toEqual({ kg: 0.5, lb: 1 });
	});
});
