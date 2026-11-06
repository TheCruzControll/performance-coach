/**
 * Simple trends for the coach (PRD §4): how a series of figures moved across a window, and
 * whether there is enough of it to say. seriesChange sets the mean of the later half of the
 * points against the mean of the earlier half, and calls a change within FLAT_WITHIN_PCT of the
 * earlier half flat.
 *
 * It describes and never judges: there is no significance test, so it never says 'real trend' or
 * 'normal variation'. Those verdicts are M6's (classifyTrend), and M6's coach-analytics-repoint
 * makes seriesChange an adapter over it that keeps this shape.
 *
 * - Points in progress (today's week) and gaps (null: no data, which is not zero) are left out,
 *   as M6's series summaries leave them out. Zeros count: a week of nothing is a real week.
 * - With an odd count the middle point belongs to neither half, so the halves are as long.
 * - Server-only: imported by path, never through domain/coach/index.ts
 *   (scripts/coach-index-imports.test.ts). Pure: no clock and no I/O.
 */
import type { IsoDate } from '../calendar.ts';
import { mean } from '../analytics/series.ts';
import type { SeriesPoint } from '../analytics/types.ts';
import { cleanFloat } from '../units.ts';

/**
 * The fewest counted points a change is stated from: two in each half. An owner's choice. (M6's
 * classifyTrend needs 6 for a verdict, TREND_MIN_POINTS: a change is a smaller claim.)
 */
export const CHANGE_MIN_POINTS = 4;

/** A change of less than this, in % of the earlier half's mean, is flat. An owner's choice. */
export const FLAT_WITHIN_PCT = 3;

/** seriesChange in words a metric's method repeats (at most METHOD_MAX characters). */
export const SERIES_CHANGE_METHOD = `mean of the later half of the weeks vs the earlier half; within ±${FLAT_WITHIN_PCT}% is flat`;

export type TrendDirection = 'up' | 'down' | 'flat';

export type SeriesChange =
	| { enoughData: false; points: number; need: number }
	| {
			enoughData: true;
			points: number;
			/** The first and the last counted point. */
			from: IsoDate;
			to: IsoDate;
			/** The means of the earlier and the later half. */
			earlier: number;
			later: number;
			delta: number;
			/** delta in % of `earlier`; null when earlier is 0, as a change from nothing has no %. */
			pct: number | null;
			direction: TrendDirection;
	  };

/** cleanFloat, with −0 read as 0. */
const clean = (value: number) => cleanFloat(value) + 0;

function directionOf(delta: number, pct: number | null): TrendDirection {
	if (pct === null ? delta === 0 : Math.abs(pct) < FLAT_WITHIN_PCT) return 'flat';
	return delta > 0 ? 'up' : 'down';
}

/**
 * How `points` changed from the earlier half to the later half, in date order. Not enough data
 * below `minPoints` counted points (CHANGE_MIN_POINTS by default, and never under 2). Throws
 * RangeError for a value that is not a finite number.
 */
export function seriesChange(
	points: readonly SeriesPoint[],
	{ minPoints = CHANGE_MIN_POINTS }: { minPoints?: number } = {}
): SeriesChange {
	const counted = points
		.filter((point) => !point.inProgress && point.value !== null)
		.sort((a, b) => a.at.localeCompare(b.at));
	const values = counted.map((point) => point.value!);
	const bad = values.find((value) => !Number.isFinite(value));
	if (bad !== undefined) throw new RangeError(`Not a finite number: ${bad}`);
	const need = Math.max(2, minPoints);
	if (values.length < need) return { enoughData: false, points: values.length, need };
	const half = Math.floor(values.length / 2);
	const earlier = mean(values.slice(0, half))!;
	const later = mean(values.slice(-half))!;
	const delta = clean(later - earlier);
	const pct = earlier === 0 ? null : clean(((later - earlier) / Math.abs(earlier)) * 100);
	return {
		enoughData: true,
		points: values.length,
		from: counted[0]!.at,
		to: counted.at(-1)!.at,
		earlier,
		later,
		delta,
		pct,
		direction: directionOf(delta, pct)
	};
}
