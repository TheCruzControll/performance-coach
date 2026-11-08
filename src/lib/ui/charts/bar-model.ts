/**
 * The bar chart's model, pure (bodies/BarChart.svelte draws it): weekly columns, or stacks by
 * discipline, as HTML boxes in percent of the data area (geometry.ts), with a planned outline per
 * column, an optional target band in the SVG, totals on the caps of a stack, and the words each
 * mark's tooltip and the table twin say.
 *
 * - One series draws a column a slot, standing on zero (a negative value hangs below it). Two or
 *   more are stacked, disciplines always in STACK_ORDER whatever order they come in; a zero,
 *   missing or negative part draws nothing and leaves no gap.
 * - The week in progress is an outlined column, never a filled one, labelled 'so far', and has no
 *   cap total: it is not complete.
 * - Every mark is a button the keyboard reaches. A slot with nothing done but something planned
 *   gets one too, standing in its planned outline, so a missed week is never unreachable.
 * - Every string a tooltip shows comes from barReadout, whose values are the table twin's
 *   (barTable) cells with the unit, so a tooltip never holds a value the table lacks.
 */
import { areaPath, column, stack, type Column } from './geometry.ts';
import { STACK_ORDER } from './palette.ts';
import { linearScale, timeTicks, type LinearScale } from './scale.ts';
import type { ChartTableData } from './table.ts';

/**
 * Room over the tallest column (or planned outline) for the label on its cap, a total or 'so far':
 * the value axis reaches at least this multiple of it.
 */
export const CAP_HEADROOM = 1.15;

export interface BarValue {
	value: number;
	/** The value as the table shows it, without its unit: '1,250'. */
	text: string;
}

export interface BarSeries {
	key: string;
	label: string;
	/** The custom property that colours it: a --chart-* token (palette.ts). */
	token: `--chart-${string}`;
	/** One per slot; null when there is no value. */
	values: readonly (BarValue | null)[];
}

export interface BarSlot {
	/** The x-axis tick: '5 Oct'. */
	tick: string;
	/** The table's row and the tooltip's heading: 'Week of 5 Oct'. */
	label: string;
	/** The week in progress: an outlined column, 'so far'. */
	inProgress?: boolean;
}

export interface BarChartData {
	/** Names the chart's keyboard group: the frame's title. */
	title: string;
	slots: readonly BarSlot[];
	/** One series is a column a slot; two or more are stacked. */
	series: readonly BarSeries[];
	/** The values' unit: 'sets'. */
	unit?: string;
	/** What was planned, a slot each: drawn as an outline around the column. */
	planned?: readonly (BarValue | null)[];
	/** A target range behind the columns, low and high; a null high is 'at least low'. */
	target?: readonly [number, number | null];
}

export interface BarMark extends Column {
	slot: number;
	/** The series' position in BarModel.series; -1 for a planned outline with nothing done. */
	series: number;
	/** The lowest part of its stack (or a lone column): it stands on the baseline. */
	first: boolean;
	/** The highest part of its stack (or a lone column): it carries the rounded data end. */
	last: boolean;
	soFar: boolean;
}

export interface BarLabel {
	slot: number;
	left: number;
	/** The top of the column or of its planned outline, whichever is higher. */
	bottom: number;
}

export interface BarModel {
	/** The series in drawing order: disciplines in STACK_ORDER. */
	series: BarSeries[];
	stacked: boolean;
	scale: LinearScale;
	/** Each slot's centre, in percent of the area's width. */
	xs: number[];
	/** One slot's width, in percent of the area's width. */
	band: number;
	/** In slot order, each slot's from the baseline up: the keyboard's order. */
	marks: BarMark[];
	plans: (Column & { slot: number })[];
	/** A stack's total on its cap, for complete slots. */
	caps: (BarLabel & { text: string; beforeSoFar: boolean })[];
	soFar: BarLabel | null;
	/** The labelled slots; a minor one hides in a narrow chart. */
	ticks: { index: number; minor: boolean }[];
	/** The target band's SVG path, '' without one. */
	targetPath: string;
	/** The forced-colors hatch of each series, alternating so stack neighbours differ. */
	hatches: ('a' | 'b')[];
}

const rank = (key: string) => {
	const at = (STACK_ORDER as readonly string[]).indexOf(key);
	return at < 0 ? STACK_ORDER.length : at;
};

/** The series in drawing order: disciplines in STACK_ORDER, any other after them as given. */
export const orderSeries = (series: readonly BarSeries[]) =>
	[...series].sort((a, b) => rank(a.key) - rank(b.key));

/** A total as the table shows it: grouped, at most one decimal. */
export const formatTotal = (value: number) =>
	value.toLocaleString('en-GB', { maximumFractionDigits: 1 });

/** The sum of a slot's drawn (positive) parts; null when every part is missing. */
function totalAt(series: readonly BarSeries[], slot: number): number | null {
	const parts = series.map((s) => s.values[slot]?.value ?? null);
	if (parts.every((v) => v === null)) return null;
	return parts.reduce<number>((sum, v) => sum + (v !== null && v > 0 ? v : 0), 0);
}

export function barModel(data: BarChartData): BarModel {
	const series = orderSeries(data.series);
	const stacked = series.length > 1;
	const n = data.slots.length;
	const tops = data.slots.map((_, i) =>
		stacked ? totalAt(series, i) : (series[0]?.values[i]?.value ?? null)
	);
	const planned = data.slots.map((_, i) => data.planned?.[i]?.value ?? null);
	const finite = [...tops, ...planned].filter((v): v is number => v !== null);
	const [low, high] = data.target ?? [];
	const scale = linearScale(
		[
			...finite,
			Math.max(0, ...finite) * CAP_HEADROOM,
			...(low === undefined ? [] : [low]),
			...(high === undefined || high === null ? [] : [high])
		],
		'bar'
	);
	const band = n ? 100 / n : 100;
	const xs = data.slots.map((_, i) => (i + 0.5) * band);
	const soFarAt = (i: number) => data.slots[i]?.inProgress === true;

	const marks: BarMark[] = [];
	const plans: BarModel['plans'] = [];
	data.slots.forEach((_, slot) => {
		const x = xs[slot]!;
		const plan = column(x, planned[slot]!, scale);
		if (plan) plans.push({ ...plan, slot });
		const soFar = soFarAt(slot);
		const drawn = stacked
			? stack(
					x,
					Object.fromEntries(series.map((s) => [s.key, s.values[slot]?.value ?? null])),
					series.map((s) => s.key),
					scale
				).map((seg) => ({
					...seg,
					negative: false,
					series: series.findIndex((s) => s.key === seg.key)
				}))
			: [column(x, tops[slot]!, scale)].flatMap((col) =>
					col ? [{ ...col, series: 0, first: true, last: true }] : []
				);
		for (const { left, bottom, height, negative, series: s, first, last } of drawn)
			marks.push({ slot, series: s, left, bottom, height, negative, first, last, soFar });
		if (!drawn.length && plan)
			marks.push({ ...plan, slot, series: -1, first: true, last: true, soFar });
	});

	const labelAt = (slot: number): BarLabel => ({
		slot,
		left: xs[slot]!,
		bottom: scale.at(Math.max(0, tops[slot] ?? 0, planned[slot] ?? 0))
	});
	const inProgress = data.slots.findIndex((slot) => slot.inProgress);
	const caps = stacked
		? data.slots.flatMap((_, slot) =>
				tops[slot] && !soFarAt(slot)
					? [
							{
								...labelAt(slot),
								text: formatTotal(tops[slot]!),
								beforeSoFar: slot === inProgress - 1
							}
						]
					: []
			)
		: [];

	const picked = timeTicks(n);
	const targetTop = high ?? scale.max;
	return {
		series,
		stacked,
		scale,
		xs,
		band,
		marks,
		plans,
		caps,
		soFar: inProgress < 0 ? null : labelAt(inProgress),
		ticks: picked.map((index, k) => ({ index, minor: (picked.length - 1 - k) % 2 === 1 })),
		targetPath:
			low === undefined
				? ''
				: areaPath(
						[0, 100].map((x) => ({ x, y: scale.at(targetTop) })),
						[0, 100].map((x) => ({ x, y: scale.at(low) }))
					),
		hatches: series.map((_, i) => (i % 2 ? 'b' : 'a'))
	};
}

/** The keys that move the roving focus between marks. */
export type BarKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

/**
 * The mark the keyboard moves to from mark `from`: ← and → to the neighbouring slot that has a
 * mark (the same series when it has one, else the nearest part), ↑ and ↓ along the stack, Home
 * and End to the first and last mark. At an edge it stays put; any other key is null.
 */
export function stepMark(model: BarModel, from: number, key: string): number | null {
	const { marks } = model;
	const mark = marks[from];
	if (!mark) return null;
	const inSlot = (slot: number) => marks.flatMap((m, i) => (m.slot === slot ? [i] : []));
	const across = (dir: -1 | 1) => {
		const here = inSlot(mark.slot);
		const level = here.indexOf(from);
		for (let slot = mark.slot + dir; slot >= 0 && slot < model.xs.length; slot += dir) {
			const there = inSlot(slot);
			if (!there.length) continue;
			return (
				there.find((i) => marks[i]!.series === mark.series) ??
				there[Math.min(level, there.length - 1)]!
			);
		}
		return from;
	};
	const along = (dir: -1 | 1) => {
		const next = from + dir;
		return marks[next]?.slot === mark.slot ? next : from;
	};
	const moves: Record<BarKey, () => number> = {
		ArrowLeft: () => across(-1),
		ArrowRight: () => across(1),
		ArrowUp: () => along(1),
		ArrowDown: () => along(-1),
		Home: () => 0,
		End: () => marks.length - 1
	};
	return key in moves ? moves[key as BarKey]() : null;
}

export interface BarReadout {
	/** 'Week of 9 Nov so far'. */
	heading: string;
	rows: {
		label: string;
		/** The table twin's cell with the unit: '6 sets'; 'No data' when missing. */
		value: string;
		/** The series' position, for its swatch; absent for a total or the plan. */
		series?: number;
	}[];
}

const withUnit = (data: BarChartData, text: string | null | undefined) =>
	text == null ? 'No data' : `${text}${data.unit ? ` ${data.unit}` : ''}`;

/** What mark `index`'s tooltip says: its slot, its part, the stack's total and the plan. */
export function barReadout(data: BarChartData, model: BarModel, index: number): BarReadout {
	const mark = model.marks[index];
	if (!mark) return { heading: '', rows: [] };
	const slot = data.slots[mark.slot]!;
	const table = barTable(data).rows[mark.slot]!;
	const s = model.series;
	const rows: BarReadout['rows'] = [];
	if (mark.series >= 0)
		rows.push({
			label: s[mark.series]!.label,
			value: withUnit(data, table.values[mark.series]),
			series: mark.series
		});
	else if (!model.stacked)
		rows.push({ label: s[0]?.label ?? '', value: withUnit(data, table.values[0]), series: 0 });
	if (model.stacked) rows.push({ label: 'Total', value: withUnit(data, table.values[s.length]) });
	if (data.planned?.[mark.slot])
		rows.push({ label: 'Planned', value: withUnit(data, data.planned[mark.slot]!.text) });
	return { heading: `${slot.label}${slot.inProgress ? ' so far' : ''}`, rows };
}

/** A mark's accessible name: 'Week of 5 Oct. Strength 6 sets, Total 16 sets, Planned 18 sets'. */
export function markName(data: BarChartData, model: BarModel, index: number): string {
	const { heading, rows } = barReadout(data, model, index);
	return `${heading}. ${rows.map((row) => `${row.label} ${row.value}`).join(', ')}`;
}

/** The table twin: a row a slot; a column a series in drawing order, then Total and Planned. */
export function barTable(data: BarChartData, rowHeader = 'Week'): ChartTableData {
	const series = orderSeries(data.series);
	const stacked = series.length > 1;
	const unit = data.unit;
	return {
		rowHeader,
		columns: [
			...series.map((s) => ({ label: s.label, unit })),
			...(stacked ? [{ label: 'Total', unit }] : []),
			...(data.planned ? [{ label: 'Planned', unit }] : [])
		],
		rows: data.slots.map((slot, i) => {
			const total = stacked ? totalAt(series, i) : null;
			return {
				label: slot.label,
				values: [
					...series.map((s) => s.values[i]?.text ?? null),
					...(stacked ? [total === null ? null : formatTotal(total)] : []),
					...(data.planned ? [data.planned[i]?.text ?? null] : [])
				],
				inProgress: slot.inProgress
			};
		})
	};
}
