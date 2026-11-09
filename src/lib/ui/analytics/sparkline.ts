/**
 * A trend tile's sparkline, computed on the server: the page receives one short `points`
 * attribute for a <polyline> in a 0–100 viewBox (stretched with preserveAspectRatio none and
 * drawn with a non-scaling 2 px stroke), so a tile costs no chart code. Pure, with no imports at
 * runtime.
 *
 * - x: each point at its own place in the series, oldest at 0 and newest at 100, so a gap keeps
 *   its width; the line joins the points either side of it, and a missing week is never drawn as
 *   zero.
 * - y: the series' lowest value at the bottom and highest at the top, inset by SPARK_INSET so the
 *   stroke and the end dot are never clipped; a flat series runs level through the middle.
 * - The week in progress is left out: a tile shows it apart, as its so-far line.
 */
import type { SeriesPoint } from '#lib/domain/analytics/types.ts';

/** How far, in viewBox units, the highest and lowest values sit from the box's edges. */
export const SPARK_INSET = 10;

export interface Sparkline {
	/** For <polyline points>: 'x,y' pairs in the 0–100 box, oldest first. */
	points: string;
	/** The newest point, where the tile draws its end dot (percentages of the box). */
	end: { x: number; y: number };
}

const round = (value: number) => Math.round(value * 100) / 100;

/** The sparkline of `points`; null when no complete point has a value. */
export function sparkline(points: readonly SeriesPoint[]): Sparkline | null {
	const complete = points.filter((point) => !point.inProgress);
	const drawn = complete.flatMap((point, index) =>
		point.value === null ? [] : [{ index, value: point.value }]
	);
	if (drawn.length === 0) return null;
	const values = drawn.map(({ value }) => value);
	const low = Math.min(...values);
	const range = Math.max(...values) - low;
	const last = complete.length - 1;
	const xy = drawn.map(({ index, value }) => ({
		x: round(last === 0 ? 100 : (index / last) * 100),
		y: round(
			range === 0 ? 50 : 100 - SPARK_INSET - ((value - low) / range) * (100 - 2 * SPARK_INSET)
		)
	}));
	return { points: xy.map(({ x, y }) => `${x},${y}`).join(' '), end: xy.at(-1)! };
}
