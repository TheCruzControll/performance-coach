/**
 * The shapes every M6 figure shares: what a point, a value and a comparison look like on the way
 * from the analytics functions to the screens and the coach.
 *
 * Conventions for src/lib/domain/analytics (M6):
 * - pure: no I/O, no clock, no randomness; today is always an argument
 * - imported by path: there is no index file
 * - no zod, and no runtime import of domain/programming or domain/exercises
 * - client-safe only when listed in scripts/analytics-client-imports.test.ts (CLIENT_SAFE)
 *
 * This module is client-safe: it holds types only.
 */
import type { IsoDate } from '../calendar.ts';

/**
 * How a figure was obtained. Measured: read from the log as entered (a load, a distance).
 * Estimated: a model's guess (an e1RM). Calculated: arithmetic over measured values (a weekly
 * total, a pace). Reported: the owner's own word (a session RPE, a race result).
 */
export type MetricKind = 'measured' | 'estimated' | 'calculated' | 'reported';

/** What a metric counts while it waits for enough data. */
export type AvailabilityUnit = 'days' | 'weeks' | 'sessions' | 'runs' | 'sets' | 'points';

/** Whether a metric can be shown yet; when not, how much data it has and needs. */
export type Availability =
	{ ready: true } | { ready: false; have: number; need: number; unit: AvailabilityUnit };

/** How a series groups its points: by Monday-to-Sunday week, or by month for long periods. */
export type Bucket = 'week' | 'month';

/**
 * One point of a series: the bucket's first day (a Monday, or the first of a month), its value
 * (null for a gap: no data, which is not zero) and whether its bucket is still in progress. A
 * point in progress is drawn apart ('so far') and never counts in a total, an average or a trend.
 */
export interface SeriesPoint {
	at: IsoDate;
	value: number | null;
	inProgress: boolean;
}

/** A single figure in canonical units (kg, metres, seconds, s/km, AU, counts); null: no data. */
export interface MetricValue {
	value: number | null;
	kind: MetricKind;
}

/** Which way is better for a metric: up (an e1RM), down (a pace in s/km) or neither (body weight). */
export type Direction = 'up' | 'down' | 'none';

/**
 * A change between two values: better or worse by the metric's direction, up or down when neither
 * is better, same when equal.
 */
export type Change = 'better' | 'worse' | 'up' | 'down' | 'same';

/**
 * A value against an earlier one: the difference, the percentage of the earlier value and the
 * change. All three are null, never NaN or Infinity, when there is nothing to compare with.
 */
export interface Comparison {
	delta: number | null;
	pct: number | null;
	change: Change | null;
}
