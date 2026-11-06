/**
 * Trend versus noise (PRD §10, §11): whether a series is really improving or declining, is only
 * moving within its normal variation, or has too little data to tell yet. One deterministic
 * classifier, so the dashboards, the reviews, the progression rules and the coach never give one
 * figure two verdicts. The method (the trend classification ADR, versioned by TREND_METHOD):
 *
 * 1. Availability. Points in progress (today's week) and gaps are dropped before anything else.
 *    A verdict needs TREND_MIN_POINTS points spanning TREND_MIN_SPAN_DAYS days; short of that the
 *    result is insufficient_data, with how many more points and days it needs.
 * 2. A Theil–Sen line: the median of every pairwise slope, through the median intercept. One wild
 *    session moves it little, where a least-squares line follows it.
 * 3. The Mann–Kendall S (pairs that rise minus pairs that fall, in date order) and its two-sided
 *    p: exact for up to 20 points without ties (the distribution of inversions in a random
 *    order), otherwise the normal approximation with tie and continuity corrections.
 * 4. noise = 1.4826 × the MAD of the residuals: the series' usual scatter around its line, as a
 *    standard deviation that one outlier cannot inflate.
 * 5. A real trend needs p < alpha and a change along the line (slope × span) of at least the
 *    larger of the metric's minimal practical change (MPC) and TREND_NOISE_MULTIPLE × noise.
 *    Anything else is normal variation: the ups and downs every series has.
 *
 * Points beyond TREND_OUTLIER_SDS robust SDs of the line are flagged as outliers, never removed:
 * they stay in every figure, and the screens and the coach can name the session. A real trend must
 * also stand, the same way, with any one of them left out, so no single wild session makes one:
 * without that check, a +20 % spike in the first or last week makes 6 to 8 % of flat series trend.
 *
 * Conventions for src/lib/domain/analytics (M6): pure (no I/O, clock or randomness), imported by
 * path (no index file), no zod, no runtime import of domain/programming or domain/exercises.
 * Server-only at runtime: only the modules listed in scripts/analytics-client-imports.test.ts are
 * client-safe, and this is not one; screens receive its results.
 */
import { daysBetween } from '../calendar.ts';
import type { IsoDate } from '../calendar.ts';
import { cleanFloat } from '../units.ts';
import { mad } from './series.ts';
import type { Direction, SeriesPoint } from './types.ts';

/** The method and its version; any change to what it decides bumps the number after the slash. */
export const TREND_METHOD = 'theil-sen+mann-kendall/1';

// The thresholds below are coaching judgements, still an open question for the owner (M6 plan):
// change them here. trend.test.ts measures their error rates on seeded series.

/** The fewest points for a verdict: 4 can never reach p < 0.05, and 5 only when perfectly ordered. */
export const TREND_MIN_POINTS = 6;
/** The fewest days from the first point to the last for a verdict: three weeks. */
export const TREND_MIN_SPAN_DAYS = 21;
/** The two-sided significance a rise or fall must reach. */
export const TREND_ALPHA = 0.05;
/** A real change is at least this many times the series' noise, however small its MPC. */
export const TREND_NOISE_MULTIPLE = 2;
/** A point further than this many robust SDs from the line is flagged as an outlier. */
export const TREND_OUTLIER_SDS = 3;

/** Scales a MAD to a standard deviation for normally distributed scatter. */
const MAD_TO_SD = 1.4826;
/** Up to this many points without ties, p is exact; beyond, the normal approximation is close. */
const EXACT_MAX_POINTS = 20;

/**
 * A metric's minimal practical change: the smallest change worth calling a trend. `abs` is in the
 * metric's own units; `rel` is a share of the line's level on the first day (0.025 for 2.5 %).
 * With both, the larger counts.
 */
export interface MinimalChange {
	abs?: number;
	rel?: number;
}

export interface TrendOptions {
	/** Which way is better for the metric: it decides whether a real trend is good. */
	direction: Direction;
	mpc?: MinimalChange;
	minPoints?: number;
	minSpanDays?: number;
	alpha?: number;
}

export interface TrendOutlier {
	at: IsoDate;
	value: number;
}

/** What every verdict carries; the figures are null when there are not two dates to fit a line. */
export interface TrendFigures {
	method: typeof TREND_METHOD;
	/** The points used: complete, with a value, outliers included. */
	n: number;
	/** Days from the first point used to the last. */
	spanDays: number;
	slopePerWeek: number | null;
	/** The change along the line from the first point to the last: slope × span. */
	change: number | null;
	/** `change` as a percentage of the line's level on the first day; null when that level is 0. */
	changePct: number | null;
	/** 1.4826 × the MAD of the residuals, in the metric's units. */
	noise: number | null;
	/** The smallest change that would count: the larger of the MPC and the noise multiple. */
	minChange: number | null;
	/** The two-sided Mann–Kendall p. */
	p: number | null;
	/** Points beyond TREND_OUTLIER_SDS robust SDs of the line, in date order; counted in every figure. */
	outliers: TrendOutlier[];
}

export type TrendResult =
	| ({ verdict: 'real_trend'; direction: 'up' | 'down'; good: boolean | null } & TrendFigures)
	| ({ verdict: 'normal_variation' } & TrendFigures)
	| ({ verdict: 'insufficient_data'; needs: { points: number; days: number } } & TrendFigures);

export type TrendVerdict = TrendResult['verdict'];

/** cleanFloat, with −0 read as 0, so a line through equal values reports exactly 0. */
const clean = (value: number) => cleanFloat(value) + 0;

/**
 * The median, unrounded: series.ts's median rounds a mean of two middle values to 6 decimals,
 * which a slope in units per day cannot afford before it is multiplied by the span.
 */
function middle(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	// A typed array sorts numerically and natively: 5,356 slopes for 104 weeks, several times faster.
	const sorted = Float64Array.from(values).sort();
	const half = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
}

/**
 * The verdict on `points` (a series' complete points; any in progress are dropped). `good` is
 * whether a real trend goes the metric's better way, null for a metric with no better way. Throws
 * RangeError for a value that is not finite or an option out of range.
 */
export function classifyTrend(points: readonly SeriesPoint[], options: TrendOptions): TrendResult {
	const {
		direction,
		mpc = {},
		minPoints = TREND_MIN_POINTS,
		minSpanDays = TREND_MIN_SPAN_DAYS,
		alpha = TREND_ALPHA
	} = options;
	checkOptions(minPoints, minSpanDays, alpha, mpc);
	const used = points
		.flatMap(({ at, value, inProgress }) => (inProgress || value === null ? [] : [{ at, value }]))
		.sort((a, b) => (a.at === b.at ? a.value - b.value : a.at < b.at ? -1 : 1));
	const bad = used.find(({ value }) => !Number.isFinite(value));
	if (bad) throw new RangeError(`Not a finite number: ${bad.value} on ${bad.at}`);

	const xs = used.map(({ at }) => daysBetween(used[0]!.at, at));
	const ys = used.map(({ value }) => value);
	const n = used.length;
	const spanDays = n === 0 ? 0 : xs[n - 1]!;
	const all = assess(xs, ys, spanDays, mpc, alpha);
	const wild = (i: number) =>
		all !== null && Math.abs(all.line.residuals[i]!) > TREND_OUTLIER_SDS * all.line.noise;
	const figures: TrendFigures = {
		method: TREND_METHOD,
		n,
		spanDays,
		slopePerWeek: all && clean(all.line.slope * 7),
		change: all && all.change,
		changePct:
			all && all.line.level !== 0 ? clean((all.change / Math.abs(all.line.level)) * 100) : null,
		noise: all && all.line.noise,
		minChange: all && all.minChange,
		p: all && all.p,
		outliers: used.filter((_, i) => wild(i))
	};
	if (n < minPoints || spanDays < minSpanDays) {
		const needs = { points: Math.max(0, minPoints - n), days: Math.max(0, minSpanDays - spanDays) };
		return { verdict: 'insufficient_data', needs, ...figures };
	}
	const moving = all?.moving ?? null;
	// The Mann–Kendall S weighs a point at either end of the window most, so test each flagged one.
	const standsWithout = (i: number) => {
		const others = (_: number, j: number) => j !== i;
		return assess(xs.filter(others), ys.filter(others), spanDays, mpc, alpha)?.moving === moving;
	};
	if (moving === null || !used.every((_, i) => !wild(i) || standsWithout(i))) {
		return { verdict: 'normal_variation', ...figures };
	}
	const good = direction === 'none' ? null : moving === direction;
	return { verdict: 'real_trend', direction: moving, good, ...figures };
}

function checkOptions(minPoints: number, minSpanDays: number, alpha: number, mpc: MinimalChange) {
	if (!Number.isInteger(minPoints) || minPoints < 3) {
		throw new RangeError(`minPoints is a whole number of at least 3: ${minPoints}`);
	}
	if (!Number.isInteger(minSpanDays) || minSpanDays < 1) {
		throw new RangeError(`minSpanDays is a whole number of at least 1: ${minSpanDays}`);
	}
	if (!(alpha > 0 && alpha < 1)) throw new RangeError(`alpha is between 0 and 1: ${alpha}`);
	for (const bound of [mpc.abs, mpc.rel]) {
		if (bound !== undefined && !(Number.isFinite(bound) && bound >= 0)) {
			throw new RangeError(`A minimal change is a finite number of at least 0: ${bound}`);
		}
	}
}

interface Line {
	slope: number;
	/** The line's value on the first day. */
	level: number;
	residuals: number[];
	noise: number;
}

/** The Theil–Sen line through (xs, ys) and its noise; null without two dates to fit it. */
function fit(xs: readonly number[], ys: readonly number[]): Line | null {
	const slopes: number[] = [];
	for (let i = 0; i < xs.length; i++) {
		for (let j = i + 1; j < xs.length; j++) {
			if (xs[j] !== xs[i]) slopes.push((ys[j]! - ys[i]!) / (xs[j]! - xs[i]!));
		}
	}
	const slope = middle(slopes);
	if (slope === null) return null;
	// The median of each point projected back along the slope to the first day.
	const level = middle(ys.map((y, i) => y - slope * xs[i]!))!;
	const residuals = ys.map((y, i) => clean(y - (level + slope * xs[i]!)));
	return { slope, level, residuals, noise: clean(MAD_TO_SD * mad(residuals)!) };
}

interface Assessment {
	line: Line;
	change: number;
	minChange: number;
	p: number;
	/** Which way a real trend goes; null for normal variation. */
	moving: 'up' | 'down' | null;
}

/** Steps 2 to 5 on points sorted by date (xs: days from the first used point). */
function assess(
	xs: readonly number[],
	ys: readonly number[],
	spanDays: number,
	mpc: MinimalChange,
	alpha: number
): Assessment | null {
	const line = fit(xs, ys);
	if (line === null) return null;
	const change = clean(line.slope * spanDays);
	const practical = Math.max(mpc.abs ?? 0, (mpc.rel ?? 0) * Math.abs(line.level));
	const minChange = clean(Math.max(practical, TREND_NOISE_MULTIPLE * line.noise));
	const p = mannKendallP(xs, ys);
	const real = p < alpha && change !== 0 && Math.abs(change) >= minChange;
	return { line, change, minChange, p, moving: real ? (change > 0 ? 'up' : 'down') : null };
}

/** The sizes of the groups of equal values (only groups of 2 or more). */
function ties(values: readonly number[]): number[] {
	const counts = new Map<number, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return [...counts.values()].filter((count) => count > 1);
}

/**
 * The two-sided p of the Mann–Kendall S for y against x (sorted by x). Pairs on the same date
 * count neither way. Exact for up to EXACT_MAX_POINTS points with no ties in either; otherwise
 * the normal approximation, with Kendall's variance for ties in both and a continuity correction.
 */
function mannKendallP(xs: readonly number[], ys: readonly number[]): number {
	const n = xs.length;
	let s = 0;
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) if (xs[j] !== xs[i]) s += Math.sign(ys[j]! - ys[i]!);
	}
	const [t, u] = [ties(xs), ties(ys)];
	if (n <= EXACT_MAX_POINTS && t.length === 0 && u.length === 0) return exactP(n, s);
	const sum = (groups: number[], f: (k: number) => number) =>
		groups.reduce((total, k) => total + f(k), 0);
	const v0 = (k: number) => k * (k - 1) * (2 * k + 5);
	const pairs = (k: number) => k * (k - 1);
	const triples = (k: number) => k * (k - 1) * (k - 2);
	const variance =
		(v0(n) - sum(t, v0) - sum(u, v0)) / 18 +
		(n > 2 ? (sum(t, triples) * sum(u, triples)) / (9 * triples(n)) : 0) +
		(sum(t, pairs) * sum(u, pairs)) / (2 * pairs(n));
	if (s === 0 || variance <= 0) return 1;
	return Math.min(1, erfc((Math.abs(s) - 1) / Math.sqrt(variance) / Math.SQRT2));
}

/**
 * The exact two-sided p of S for n untied points. With N = n(n − 1)/2 pairs, S = N − 2I, where I
 * is the number of inversions in the order of the values; under no trend every order is equally
 * likely, so I follows the Mahonian distribution, built here one point at a time as probabilities
 * (adding the m-th point adds 0 to m − 1 inversions, each with chance 1/m).
 */
function exactP(n: number, s: number): number {
	if (s === 0) return 1;
	let chances = [1];
	for (let m = 2; m <= n; m++) {
		const next = new Array<number>(chances.length + m - 1).fill(0);
		for (const [k, chance] of chances.entries()) {
			for (let added = 0; added < m; added++) next[k + added]! += chance / m;
		}
		chances = next;
	}
	// S ≥ |s| exactly when I ≤ (N − |s|) / 2; the distribution is symmetric, so double the tail.
	const most = ((n * (n - 1)) / 2 - Math.abs(s)) / 2;
	const tail = chances.slice(0, most + 1).reduce((total, chance) => total + chance, 0);
	return Math.min(1, 2 * tail);
}

/**
 * The complementary error function, with a fractional error under 1.2 × 10⁻⁷ (the Chebyshev fit
 * in Press et al., Numerical Recipes, §6.2): far finer than any p a verdict turns on.
 */
function erfc(x: number): number {
	const t = 1 / (1 + 0.5 * Math.abs(x));
	const polynomial = [
		-1.26551223, 1.00002368, 0.37409196, 0.09678418, -0.18628806, 0.27886807, -1.13520398,
		1.48851587, -0.82215223, 0.17087277
	].reduceRight((acc, coefficient) => coefficient + t * acc, 0);
	const value = t * Math.exp(-x * x + polynomial);
	return x >= 0 ? value : 2 - value;
}
