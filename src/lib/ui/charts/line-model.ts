/**
 * The line chart's model, pure (bodies/LineChart.svelte draws it): series to SVG paths, HTML
 * marker positions, tick and end labels, and the hit bands a pointer answers in, all in percent of
 * the data area (geometry.ts), plus the words a tooltip, the live region and the table twin say.
 *
 * - Markers: an estimated value is a hollow ring and a measured one a square diamond, on every
 *   point that has a kind, so an estimate never looks measured. A point without a kind gets a mark
 *   only as its series' end (an 8 px dot) or when it stands alone between gaps, where no line can
 *   show it. The week in progress is a dashed ring labelled 'so far', whatever its kind.
 * - The line runs through complete points; a gap (null) breaks it. The point in progress joins it
 *   by a quieter link, never as part of the line.
 * - Every string a tooltip or the live region shows comes from pointText, which the table twin
 *   (lineTable) uses too, so a tooltip never holds a value the table lacks.
 */
import { areaPath, endLabels, hitBands, linePath, type Point } from './geometry.ts';
import { linearScale, timeTicks, type LinearScale } from './scale.ts';
import type { ChartTableData } from './table.ts';

/** At most this many series share a line chart; past that, small multiples (design-system.md). */
export const MAX_LINE_SERIES = 4;

/**
 * The least distance between two end labels, in percent of the data area's height: a 12 px label
 * and 2 px of air in ChartFrame's default plot (13rem less the 1.75rem axis band, 180 px). Closer
 * labels are moved apart and drawn with a leader line to their series' end.
 */
export const END_LABEL_GAP = 8;

/** A 'so far' label goes under its ring from this height (percent), so it never leaves the plot. */
export const SO_FAR_LABEL_FLIP = 80;

/** How a value was found: a hollow ring for an estimate, a square diamond for a measurement. */
export type PointKind = 'estimated' | 'measured';

export interface LinePoint {
	value: number;
	/** The value as the table shows it, without its unit: '142.5'. */
	text: string;
	/** Estimated or measured; a calculated value (a weekly total) has none. */
	kind?: PointKind;
}

export interface LineSeries {
	key: string;
	label: string;
	/** The custom property that colours it: a --chart-* token (palette.ts). */
	token: `--chart-${string}`;
	/** One per slot; null is a gap. */
	points: readonly (LinePoint | null)[];
}

export interface LineSlot {
	/** The x-axis tick: '5 Oct'. */
	tick: string;
	/** The table's row and the tooltip's heading: 'Week of 5 Oct'. */
	label: string;
	/** The week in progress: shown apart as 'so far'. */
	inProgress?: boolean;
}

export interface LineChartData {
	/** Names the chart's keyboard group: the frame's title. */
	title: string;
	slots: readonly LineSlot[];
	/** Up to MAX_LINE_SERIES, in their fixed order: legend, end labels, tooltip and table. */
	series: readonly LineSeries[];
	/** The values' unit, as the table's column headers carry it: 'kg'. */
	unit?: string;
	/** A target range drawn as a quiet band behind the lines. */
	target?: readonly [number, number];
	/** A reference value drawn as the baseline. */
	baseline?: number;
}

/** What a mark draws: a point's kind, the end dot, a lone point's dot, or the week in progress. */
export type MarkKind = PointKind | 'end' | 'lone' | 'so-far';

export interface LineMark {
	/** The series' position in `series`. */
	series: number;
	index: number;
	left: number;
	bottom: number;
	kind: MarkKind;
}

export interface LineEndLabel {
	series: number;
	/** Where the series ends, in percent of the area. */
	x: number;
	y: number;
	labelY: number;
	/** The label was moved off its value: an SVG leader joins it to the series' end. */
	leader: string | null;
}

export interface LineModel {
	scale: LinearScale;
	/** Each slot's centre, in percent of the area's width. */
	xs: number[];
	/** Per series: the line through complete points, and the link to its point in progress. */
	paths: { line: string; link: string }[];
	marks: LineMark[];
	/** The labelled slots; a minor one hides in a narrow chart, every other one from the newest. */
	ticks: { index: number; minor: boolean }[];
	/** The series' names at their ends; none for one series, which the chart's title names. */
	endLabels: LineEndLabel[];
	/** A legend names the series when there are two or more. */
	legend: boolean;
	/** The marker shapes the chart draws, each named in the legend. */
	shapes: { estimated: boolean; measured: boolean; soFar: boolean };
	/** One 'so far' label, over the highest ring in progress (or under it near the top). */
	soFar: { x: number; y: number; below: boolean } | null;
	hits: ReturnType<typeof hitBands>;
	/** The target band's SVG path, '' without one. */
	band: string;
	/** The baseline's height in percent, null without one. */
	baseline: number | null;
}

/** A value in words, the same in the table, the tooltip and the live region: '142.5, estimated'. */
export function pointText(point: LinePoint | null | undefined): string | null {
	if (!point) return null;
	return point.kind ? `${point.text}, ${point.kind}` : point.text;
}

/** Was the slot complete when this point was taken (not the week in progress)? */
const complete = (data: LineChartData, i: number) => !data.slots[i]?.inProgress;

export function lineModel(data: LineChartData): LineModel {
	if (data.series.length > MAX_LINE_SERIES)
		throw new RangeError(`a line chart takes at most ${MAX_LINE_SERIES} series`);
	const n = data.slots.length;
	const values = data.series.flatMap((s) => s.points.map((p) => p?.value ?? null));
	const scale = linearScale(
		[...values, ...(data.target ?? []), ...(data.baseline === undefined ? [] : [data.baseline])],
		'line'
	);
	const xs = data.slots.map((_, i) => ((i + 0.5) * 100) / n);
	const at = (i: number, point: LinePoint | null | undefined): Point | null =>
		point ? { x: xs[i]!, y: scale.at(point.value) } : null;

	const paths = data.series.map((s) => {
		const solid = data.slots.map((_, i) => (complete(data, i) ? at(i, s.points[i]) : null));
		const link = data.slots.flatMap((_, i) => {
			const from = at(i - 1, s.points[i - 1]);
			const to = at(i, s.points[i]);
			return !complete(data, i) && complete(data, i - 1) && from && to
				? [linePath([from, to])]
				: [];
		});
		return { line: linePath(solid), link: link.join('') };
	});

	/** Each series' last complete point: where its end dot and its end label go. */
	const ends = data.series.map((s) =>
		s.points.findLastIndex((point, i) => point !== null && complete(data, i))
	);

	const marks: LineMark[] = [];
	data.series.forEach((s, series) => {
		s.points.forEach((point, index) => {
			if (!point) return;
			const lone = !s.points[index - 1] && !s.points[index + 1];
			const kind: MarkKind | null = !complete(data, index)
				? 'so-far'
				: (point.kind ?? (index === ends[series] ? 'end' : lone ? 'lone' : null));
			if (kind) marks.push({ series, index, kind, ...box(at(index, point)!) });
		});
	});

	const picked = timeTicks(n);
	const ticks = picked.map((index, k) => ({ index, minor: (picked.length - 1 - k) % 2 === 1 }));

	const legend = data.series.length >= 2;
	const ending = legend
		? data.series.flatMap((s, series) => {
				const point = at(ends[series]!, s.points[ends[series]!]);
				return point ? [{ key: String(series), series, x: point.x, y: point.y }] : [];
			})
		: [];
	const labels = endLabels(ending, END_LABEL_GAP).map((label, k) => {
		const { x, series } = ending[k]!;
		return {
			series,
			x,
			y: label.y,
			labelY: label.labelY,
			leader: label.leader
				? linePath([
						{ x, y: label.y },
						{ x: 100, y: label.labelY }
					])
				: null
		};
	});

	const soFarMarks = marks.filter((mark) => mark.kind === 'so-far');
	const top = soFarMarks.reduce<LineMark | null>(
		(a, b) => (!a || b.bottom > a.bottom ? b : a),
		null
	);

	return {
		scale,
		xs,
		paths,
		marks,
		ticks,
		endLabels: labels,
		legend,
		shapes: {
			estimated: marks.some((m) => m.kind === 'estimated'),
			measured: marks.some((m) => m.kind === 'measured'),
			soFar: soFarMarks.length > 0
		},
		soFar: top ? { x: top.left, y: top.bottom, below: top.bottom >= SO_FAR_LABEL_FLIP } : null,
		hits: hitBands(xs),
		band: data.target
			? areaPath(
					[0, 100].map((x) => ({ x, y: scale.at(data.target![1]) })),
					[0, 100].map((x) => ({ x, y: scale.at(data.target![0]) }))
				)
			: '',
		baseline: data.baseline === undefined ? null : scale.at(data.baseline)
	};
}

const box = (point: Point) => ({ left: point.x, bottom: point.y });

export interface LineReadout {
	/** 'Week of 9 Nov so far'. */
	heading: string;
	rows: {
		series: number;
		label: string;
		/** The value with its unit, null for a gap: '142.5 kg'. */
		value: string | null;
		kind: PointKind | null;
		/** The table twin's cell for it, word for word. */
		cell: string | null;
	}[];
}

/** What the tooltip lists at slot `index`: every series, a gap included. */
export function readout(data: LineChartData, index: number): LineReadout {
	const slot = data.slots[index];
	return {
		heading: slot ? `${slot.label}${slot.inProgress ? ' so far' : ''}` : '',
		rows: data.series.map((s, series) => {
			const point = s.points[index] ?? null;
			return {
				series,
				label: s.label,
				value: point ? `${point.text}${data.unit ? ` ${data.unit}` : ''}` : null,
				kind: point?.kind ?? null,
				cell: pointText(point)
			};
		})
	};
}

/** The live region's sentence for slot `index`: 'Week of 9 Nov so far: Back squat 142.5 kg, estimated.' */
export function announce(data: LineChartData, index: number): string {
	const { heading, rows } = readout(data, index);
	const parts = rows.map(
		(row) =>
			`${row.label} ${row.value ? `${row.value}${row.kind ? `, ${row.kind}` : ''}` : 'no data'}`
	);
	return `${heading}: ${parts.join('; ')}.`;
}

/** The table twin: a row a slot, a column a series, each cell pointText. */
export function lineTable(data: LineChartData, rowHeader = 'Week'): ChartTableData {
	return {
		rowHeader,
		columns: data.series.map((s) => ({ label: s.label, unit: data.unit })),
		rows: data.slots.map((slot, i) => ({
			label: slot.label,
			values: data.series.map((s) => pointText(s.points[i])),
			inProgress: slot.inProgress
		}))
	};
}
