/**
 * Body weight, from the owner's weigh-ins: a smoothed trend weight, the weekly rate, the rate bars,
 * the period stats and the log book rows. The weight tracking screens, the goal (weight-goal.ts)
 * and the coach all read these figures, so one method decides them all.
 *
 * The method:
 *
 * 1. Every weigh-in is converted into the owner's unit first (convertWeight), so kg and lb entries
 *    mix in one series. Outputs are rounded to 2 decimals (cleanFloat). The trend is carried
 *    unrounded; the figures read from it (rates, changes) use the trend as shown.
 * 2. The series has one point a day, from the first weigh-in to the last. A skipped day takes a
 *    weight by linear interpolation between the weigh-ins either side (filled: true, weight null),
 *    so a weekly weigher and a daily one see the same path. The series is never extended past the
 *    last weigh-in.
 * 3. The trend is the exponentially smoothed moving average of John Walker's Hacker's Diet:
 *    T(first) = w(first), then T(d) = T(d − 1) + TREND_ALPHA × (w(d) − T(d − 1)). A day's weight
 *    moves the trend a tenth of the way, so one heavy or light morning barely shows.
 * 4. Rates and changes read the trend, never a single weigh-in. The raw weigh-ins are kept for the
 *    highs and lows and for the log book's change column.
 *
 * A window (from, to) is inclusive of both days; from null means from the first weigh-in. Ties
 * between equal weights (compared as shown, to 2 decimals) go to the earlier weigh-in.
 *
 * Conventions for src/lib/domain/analytics (M6): pure (no I/O, clock or randomness), imported by
 * path (no index file), no zod, no runtime import of domain/programming or domain/exercises.
 * Server-only at runtime: this is not listed in scripts/analytics-client-imports.test.ts, so screens
 * receive its results.
 */
import { addDays, daysBetween, mondayOf } from '../calendar.ts';
import type { IsoDate } from '../calendar.ts';
import { cleanFloat, convertWeight } from '../units.ts';
import type { WeightUnit } from '../units.ts';

/** The smoothing factor: the Hacker's Diet's tenth of each day's difference from the trend. */
export const TREND_ALPHA = 0.1;
/** The trend goes stale once the last weigh-in is more than this many days before the day asked for. */
export const STALE_DAYS = 7;
/** How far the trend may sit from the goal line and still be on track, per unit (weight-goal.ts). */
export const TOLERANCE: Record<WeightUnit, number> = { kg: 0.5, lb: 1 };

/** A weigh-in: its day, and its weight in the unit it was entered in. */
export interface WeighIn {
	measuredOn: IsoDate;
	value: number;
	unit: WeightUnit;
}

/** One day of the trend series, in the unit asked for; weights and trend rounded to 2 decimals. */
export interface TrendDay {
	day: IsoDate;
	/** The day's weigh-in; null on a skipped day, whose weight is interpolated (filled: true). */
	weight: number | null;
	filled: boolean;
	trend: number;
}

/** A weight on a day: a raw weigh-in, as the stats show it. */
export interface Reading {
	day: IsoDate;
	weight: number;
}

/** The trend weight on a day; `stale` once the last weigh-in is more than STALE_DAYS before it. */
export interface TrendReading {
	trend: number;
	stale: boolean;
}

/**
 * One bar of the weekly rate chart: the trend change over a Monday-to-Sunday week, from the
 * previous week's last day. A week with no data has no bar. The current week is `soFar`.
 */
export interface RateBar {
	/** The week's Monday. */
	week: IsoDate;
	/** Null for the first week of the series, which has no week before it to compare with. */
	change: number | null;
	soFar: boolean;
}

/** The stats for a window; every value is null when the window holds no weigh-in. */
export interface WeightStats {
	latest: Reading | null;
	/** The trend at the end of the window. */
	trend: number | null;
	highest: Reading | null;
	lowest: Reading | null;
	/** The trend at the end of the window minus the trend at its start. */
	change: number | null;
	weeklyRate: number | null;
}

/** One weigh-in in the log book, newest first in the list. */
export interface LogRow {
	day: IsoDate;
	weight: number;
	/** The trend on the day. */
	trend: number;
	/** The weight minus the previous weigh-in's; null for the first. */
	change: number | null;
	/** The trend on the day minus the trend seven days earlier; null before the seventh series day. */
	weeklyRate: number | null;
}

/** cleanFloat to 2 decimals, with −0 read as 0 so a change of nothing shows as 0. */
const round = (value: number) => cleanFloat(value, 2) + 0;

/** A weigh-in in the owner's unit. */
interface Weighed {
	day: IsoDate;
	value: number;
}

/**
 * The weigh-ins converted into `unit`, oldest first. Throws RangeError for a weight that is not
 * finite, or for two weigh-ins on one day (the store allows one a day, so that is a caller's bug).
 */
function inUnit(entries: readonly WeighIn[], unit: WeightUnit): Weighed[] {
	const weighed = entries
		.map(({ measuredOn, value, unit: from }) => {
			if (!Number.isFinite(value)) {
				throw new RangeError(`Not a finite weight on ${measuredOn}: ${value}`);
			}
			return { day: measuredOn, value: convertWeight(value, from, unit) };
		})
		.sort((a, b) => (a.day === b.day ? 0 : a.day < b.day ? -1 : 1));
	for (let i = 1; i < weighed.length; i++) {
		if (weighed[i]!.day === weighed[i - 1]!.day) {
			throw new RangeError(`More than one weigh-in on ${weighed[i]!.day}`);
		}
	}
	return weighed;
}

/** The trend series over the weigh-ins (oldest first): one day a day, no day past the last. */
function seriesOf(weighed: readonly Weighed[]): TrendDay[] {
	if (weighed.length === 0) return [];
	const first = weighed[0]!.day;
	const span = daysBetween(first, weighed[weighed.length - 1]!.day);
	const series: TrendDay[] = [];
	let trend = 0;
	// The last weigh-in on or before the day being built; the next one is always after it.
	let at = 0;
	for (let n = 0; n <= span; n++) {
		const day = addDays(first, n);
		if (at + 1 < weighed.length && weighed[at + 1]!.day === day) at++;
		const earlier = weighed[at]!;
		const weighedOn = earlier.day === day;
		let value = earlier.value;
		if (!weighedOn) {
			const later = weighed[at + 1]!;
			const fraction = daysBetween(earlier.day, day) / daysBetween(earlier.day, later.day);
			value = earlier.value + (later.value - earlier.value) * fraction;
		}
		trend = n === 0 ? value : trend + TREND_ALPHA * (value - trend);
		series.push({
			day,
			weight: weighedOn ? round(value) : null,
			filled: !weighedOn,
			trend: round(trend)
		});
	}
	return series;
}

/**
 * The trend series for the weigh-ins in `unit`, from the first to the last weigh-in, one point a
 * day. Empty with no weigh-ins.
 */
export function dailyTrend(entries: readonly WeighIn[], unit: WeightUnit): TrendDay[] {
	return seriesOf(inUnit(entries, unit));
}

/**
 * The trend on `day`, from a series made by dailyTrend. After the last weigh-in the trend is held
 * at its last value, and is stale once the gap is more than STALE_DAYS. Null before the first
 * weigh-in, or with no series.
 */
export function trendOn(series: readonly TrendDay[], day: IsoDate): TrendReading | null {
	const first = series[0];
	const last = series[series.length - 1];
	if (first === undefined || last === undefined || day < first.day) return null;
	if (day > last.day) {
		return { trend: last.trend, stale: daysBetween(last.day, day) > STALE_DAYS };
	}
	return { trend: series[daysBetween(first.day, day)]!.trend, stale: false };
}

/**
 * The weekly rate of the trend over [from, to]: the least-squares slope of the trend, times 7.
 * Null with fewer than 7 series days in the window, or fewer than 2 weigh-ins in it.
 */
export function weeklyRate(series: readonly TrendDay[], from: IsoDate, to: IsoDate): number | null {
	const points = series.filter((point) => point.day >= from && point.day <= to);
	const weighed = points.filter((point) => point.weight !== null).length;
	if (points.length < 7 || weighed < 2) return null;
	const xs = points.map((point) => daysBetween(points[0]!.day, point.day));
	const ys = points.map((point) => point.trend);
	const meanX = xs.reduce((sum, x) => sum + x, 0) / xs.length;
	const meanY = ys.reduce((sum, y) => sum + y, 0) / ys.length;
	let covariance = 0;
	let variance = 0;
	for (let i = 0; i < xs.length; i++) {
		covariance += (xs[i]! - meanX) * (ys[i]! - meanY);
		variance += (xs[i]! - meanX) ** 2;
	}
	return round((covariance / variance) * 7);
}

/**
 * One bar per Monday-to-Sunday week that has data, oldest first: the trend on the week's last
 * series day minus the trend on the previous Sunday. The series ends at the last weigh-in, so the
 * weeks after it have no bar. `today` marks the current week as soFar.
 */
export function weeklyRateBars(series: readonly TrendDay[], today: IsoDate): RateBar[] {
	const first = series[0];
	const last = series[series.length - 1];
	if (first === undefined || last === undefined) return [];
	const currentWeek = mondayOf(today);
	const bars: RateBar[] = [];
	for (let week = mondayOf(first.day); week <= last.day; week = addDays(week, 7)) {
		const sunday = addDays(week, 6);
		const end = sunday < last.day ? sunday : last.day;
		const before = addDays(week, -1);
		const endTrend = trendOn(series, end)!.trend;
		const beforeTrend = before < first.day ? null : trendOn(series, before)!.trend;
		bars.push({
			week,
			change: beforeTrend === null ? null : round(endTrend - beforeTrend),
			soFar: week === currentWeek
		});
	}
	return bars;
}

/**
 * The stats for the window (from, to): the latest weigh-in, the trend at the end, the highest and
 * lowest weigh-ins, the change of trend across the window (from the trend at its start, or the
 * first weigh-in, whichever is later), and the weekly rate over the window. Every value is null
 * when the window holds no weigh-in.
 */
export function weightStats(
	entries: readonly WeighIn[],
	unit: WeightUnit,
	{ from, to }: { from: IsoDate | null; to: IsoDate }
): WeightStats {
	const weighed = inUnit(entries, unit);
	const inWindow = weighed.filter(({ day }) => (from === null || day >= from) && day <= to);
	if (inWindow.length === 0) {
		return {
			latest: null,
			trend: null,
			highest: null,
			lowest: null,
			change: null,
			weeklyRate: null
		};
	}
	const series = seriesOf(weighed);
	const start = from === null || from < series[0]!.day ? series[0]!.day : from;
	let highest = inWindow[0]!;
	let lowest = inWindow[0]!;
	for (const point of inWindow) {
		if (round(point.value) > round(highest.value)) highest = point;
		if (round(point.value) < round(lowest.value)) lowest = point;
	}
	const latest = inWindow[inWindow.length - 1]!;
	const end = trendOn(series, to)!.trend;
	const begin = trendOn(series, start)!.trend;
	const reading = ({ day, value }: Weighed): Reading => ({ day, weight: round(value) });
	return {
		latest: reading(latest),
		trend: end,
		highest: reading(highest),
		lowest: reading(lowest),
		change: round(end - begin),
		weeklyRate: weeklyRate(series, start, to)
	};
}

/**
 * The log book, one row per weigh-in, newest first: the weight, the trend on that day, the change
 * from the previous weigh-in (of the weights shown) and the weekly rate of the trend.
 */
export function logBook(entries: readonly WeighIn[], unit: WeightUnit): LogRow[] {
	const weighed = inUnit(entries, unit);
	const series = seriesOf(weighed);
	return weighed
		.map((point, i) => {
			const index = daysBetween(series[0]!.day, point.day);
			const shown = round(point.value);
			return {
				day: point.day,
				weight: shown,
				trend: series[index]!.trend,
				change: i === 0 ? null : round(shown - round(weighed[i - 1]!.value)),
				weeklyRate: index < 7 ? null : round(series[index]!.trend - series[index - 7]!.trend)
			};
		})
		.reverse();
}
