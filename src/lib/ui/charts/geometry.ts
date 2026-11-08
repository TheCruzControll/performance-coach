/**
 * Where marks go, pure, in percent of the plot box (docs/adr/NNNN-hand-built-charts.md):
 * - the SVG draws only lines and areas, in a 0–100 viewBox stretched to the box
 *   (preserveAspectRatio none) with non-scaling strokes, so its paths are written in percent;
 * - every mark with a pixel size (a column, a stack segment, a marker, a hit area, a label) is an
 *   HTML box placed in percent, `left` and `bottom`, and sized in CSS px by marks.css.
 * Every position this module returns is clamped to 0–100.
 */
import type { LinearScale } from './scale.ts';

/** A point in percent of the plot: x from the left, y from the bottom. */
export interface Point {
	x: number;
	y: number;
}

const clamp = (v: number) => Math.min(100, Math.max(0, v));
/** A path coordinate: clamped, three decimals, and the SVG's y, which runs down. */
const px = (p: Point) => `${+clamp(p.x).toFixed(3)} ${+(100 - clamp(p.y)).toFixed(3)}`;

/** The runs of consecutive points between gaps (nulls), each with its points' indices. */
function runs<T>(points: readonly (T | null)[]): number[][] {
	const found: number[][] = [];
	let run: number[] = [];
	points.forEach((point, i) => {
		if (point === null) {
			if (run.length) found.push(run);
			run = [];
		} else run.push(i);
	});
	if (run.length) found.push(run);
	return found;
}

/** An SVG path through `points`; a null breaks the line, so a missing week is never bridged. */
export function linePath(points: readonly (Point | null)[]): string {
	return runs(points)
		.map((run) => run.map((i, k) => `${k ? 'L' : 'M'}${px(points[i]!)}`).join(''))
		.join('');
}

/**
 * A filled SVG path between `upper` and `base`: a constant y (the baseline, 0 by default) or a
 * lower edge point for point, as for a target range. Where either edge has a gap, the area breaks.
 */
export function areaPath(
	upper: readonly (Point | null)[],
	base: number | readonly (Point | null)[] = 0
): string {
	const lower = (i: number): Point | null => {
		if (typeof base !== 'number') return base[i] ?? null;
		const top = upper[i];
		return top ? { x: top.x, y: base } : null;
	};
	const both = upper.map((point, i) => (point && lower(i) ? point : null));
	return runs(both)
		.map((run) => {
			const edge = [...run.map((i) => upper[i]!), ...run.reverse().map((i) => lower(i)!)];
			return `${edge.map((p, k) => `${k ? 'L' : 'M'}${px(p)}`).join('')}Z`;
		})
		.join('');
}

/** An HTML mark's box: its centre `left`, its `bottom` and `height`, in percent of the plot. */
export interface Box {
	left: number;
	bottom: number;
	height: number;
}

export interface Column extends Box {
	/** Below zero: the data end, the rounded one, is at the bottom. */
	negative: boolean;
}

/** A column for `value` centred at `x`, standing on zero; a zero value draws nothing. */
export function column(x: number, value: number | null, scale: LinearScale): Column | null {
	if (value === null || value === 0 || !Number.isFinite(value)) return null;
	const zero = scale.at(0);
	const end = scale.at(value);
	return {
		left: clamp(x),
		bottom: Math.min(zero, end),
		height: Math.abs(end - zero),
		negative: value < 0
	};
}

export interface Segment<K extends string> extends Box {
	key: K;
	/** The lowest segment drawn: it stands on the baseline, with no gap under it. */
	first: boolean;
	/** The highest segment drawn: it carries the column's rounded data end. */
	last: boolean;
}

/**
 * A stacked column at `x`: its parts in `order` from the baseline up (STACK_ORDER for
 * disciplines). A zero, negative or missing part draws nothing and leaves no gap.
 */
export function stack<K extends string>(
	x: number,
	parts: Partial<Record<K, number | null>>,
	order: readonly K[],
	scale: LinearScale
): Segment<K>[] {
	const drawn = order.filter((key) => (parts[key] ?? 0) > 0);
	let sum = 0;
	return drawn.map((key, i) => {
		const bottom = scale.at(sum);
		sum += parts[key]!;
		return {
			key,
			left: clamp(x),
			bottom,
			height: scale.at(sum) - bottom,
			first: i === 0,
			last: i === drawn.length - 1
		};
	});
}

/** A marker at each point (skipping gaps), with the index of the value it stands for. */
export function markers(
	points: readonly (Point | null)[]
): { index: number; left: number; bottom: number }[] {
	return points.flatMap((point, index) =>
		point ? [{ index, left: clamp(point.x), bottom: clamp(point.y) }] : []
	);
}

export interface EndLabel<K extends string> {
	key: K;
	/** The series' last value, in percent from the bottom. */
	y: number;
	/** Where its label sits, moved apart from its neighbours. */
	labelY: number;
	/** The label moved: draw a leader line from it to the series' end. */
	leader: boolean;
}

/**
 * Labels at the end of each series, at least `gap` percent apart (a label's height over the
 * plot's), in the series' own order bottom to top and inside 0–100. A label pushed off its value
 * gets a leader. When they cannot all fit, the gap shrinks to share the height.
 */
export function endLabels<K extends string>(
	items: readonly { key: K; y: number }[],
	gap: number
): EndLabel<K>[] {
	const order = items.map((item, i) => ({ ...item, i })).sort((a, b) => a.y - b.y || a.i - b.i);
	const step = order.length > 1 ? Math.min(gap, 100 / (order.length - 1)) : 0;
	const placed = order.map((item) => clamp(item.y));
	for (let k = 1; k < placed.length; k++) placed[k] = Math.max(placed[k]!, placed[k - 1]! + step);
	for (let k = placed.length - 1; k >= 0; k--) {
		const ceiling = k === placed.length - 1 ? 100 : placed[k + 1]! - step;
		placed[k] = clamp(Math.min(placed[k]!, ceiling));
	}
	const labels = new Array<EndLabel<K>>(items.length);
	order.forEach((item, k) => {
		const labelY = +placed[k]!.toFixed(6);
		labels[item.i] = {
			key: item.key,
			y: clamp(item.y),
			labelY,
			leader: Math.abs(labelY - clamp(item.y)) > 1e-6
		};
	});
	return labels;
}

/** The band of the plot each point answers a pointer in: halfway to each neighbour. */
export function hitBands(xs: readonly number[]): { left: number; width: number; center: number }[] {
	return xs.map((x, i) => {
		const left = i === 0 ? 0 : clamp((xs[i - 1]! + x) / 2);
		const right = i === xs.length - 1 ? 100 : clamp((x + xs[i + 1]!) / 2);
		return { left, width: right - left, center: clamp(x) };
	});
}
