/**
 * The bar chart's model, pure (bodies/BarChart.svelte draws it): weekly columns, or stacks by
 * discipline, as HTML boxes in percent of the data area (geometry.ts), with a planned outline per
 * column, an optional target band in the SVG, totals on the caps of the highest and the latest
 * complete stacks, and the words each mark's tooltip and the table twin say.
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
 *
 * Below it, the horizontal layouts: muscle-group volume against its target range (rangeModel)
 * and actual minus target RPE either side of zero (divergingModel).
 */
import { areaPath, column, stack, type Column } from './geometry.ts';
import { STACK_ORDER } from './palette.ts';
import { formatTick, linearScale, timeTicks, type LinearScale } from './scale.ts';
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
	/** A stack's total on its cap: the highest complete stack's and the latest complete one's. */
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
	// Only the highest complete stack (the latest of a tie) and the latest one carry their total:
	// a total on every cap collides with its neighbours' in a wide chart. A highest stack right
	// next to the latest gives up its total, since two neighbouring totals overlap too.
	const complete = data.slots.flatMap((_, slot) => (tops[slot] && !soFarAt(slot) ? [slot] : []));
	const highest = complete.reduce<number | null>(
		(best, slot) => (best === null || tops[slot]! >= tops[best]! ? slot : best),
		null
	);
	const latest = complete.at(-1);
	const labelled = new Set(
		highest !== null && latest !== undefined && highest === latest - 1
			? [latest]
			: [highest, latest]
	);
	const caps = stacked
		? data.slots.flatMap((_, slot) =>
				labelled.has(slot)
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

/*
 * Horizontal bars, one row each, read top to bottom (bodies/RangeBars.svelte and
 * bodies/DivergingBars.svelte, drawn by RowList.svelte): positions are percent of a row's width.
 * Every status is a word in the row, its tooltip and the table twin, never a colour alone.
 */

/** A row's room in rem, its 44 px target and head line included; the frame reserves rows × this. */
export const ROW_REM = 3;
/** The legend line over the rows and the value axis band under them (--chart-axis-band), in rem. */
const LEGEND_REM = 1.5;
const AXIS_REM = 1.75;

/** The plot height a frame reserves for `rows` rows, their legend and their axis. */
export const rowsHeight = (rows: number) => `${rows * ROW_REM + LEGEND_REM + AXIS_REM}rem`;

/** A row's tooltip and accessible name, from the table twin's own cells. */
export interface RowReadout {
	heading: string;
	rows: { label: string; value: string }[];
}

/** A row's accessible name: 'Chest. Done 14 sets, Target 10–20 sets, Status Within range'. */
export const rowName = ({ heading, rows }: RowReadout) =>
	`${heading}. ${rows.map((row) => `${row.label} ${row.value}`).join(', ')}`;

/** The row the keyboard moves to: ↑ or ← the one above, ↓ or → the one below, Home and End. */
export function stepRow(count: number, from: number, key: string): number | null {
	const to: Record<string, number> = {
		ArrowUp: from - 1,
		ArrowLeft: from - 1,
		ArrowDown: from + 1,
		ArrowRight: from + 1,
		Home: 0,
		End: count - 1
	};
	return key in to ? Math.min(count - 1, Math.max(0, to[key]!)) : null;
}

/** An axis tick under the rows: where it sits and what it says. */
export interface RowTick {
	at: number;
	text: string;
	zero: boolean;
}

const rowTicks = (scale: LinearScale): RowTick[] =>
	scale.ticks.map((tick) => ({
		at: scale.at(tick),
		text: formatTick(tick, scale.step),
		zero: tick === 0
	}));

// Muscle-group volume against its target range.

/**
 * How far past the largest value, plan or range low the axis reaches to show a range's high. A
 * high beyond it is clipped at the axis end and drawn open (its number stays in words), so one
 * wide range never squeezes every bar.
 */
export const BRACKET_REACH = 1.5;

export type RangeStatus = 'below' | 'within' | 'above';

/** Each status in words; the icon beside it repeats it, the colour never carries it. */
export const RANGE_STATUS: Readonly<Record<RangeStatus, string>> = {
	below: 'Below range',
	within: 'Within range',
	above: 'Above range'
};

export interface RangeRow {
	key: string;
	/** 'Chest'. */
	label: string;
	/** What was done; null when there is no value. */
	value: BarValue | null;
	/** The target range, low and high, inclusive. */
	range: readonly [number, number];
	/** What was planned: a tick across the bar. */
	planned?: BarValue | null;
}

export interface RangeBarsData {
	title: string;
	/** 'sets'. */
	unit?: string;
	/** The one hue every bar wears: a --chart-* series token. */
	token: `--chart-${string}`;
	rows: readonly RangeRow[];
}

export interface RangeMark {
	row: RangeRow;
	status: RangeStatus | null;
	/** The bar's length from zero. */
	width: number;
	/** The target range's bracket; `open` when its high lies past the axis end. */
	bracket: { left: number; width: number; open: boolean };
	/** Where the planned tick crosses the bar; null without a plan. */
	tick: number | null;
}

export interface RangeModel {
	/** Largest first; equal values by name. */
	marks: RangeMark[];
	ticks: RowTick[];
}

export const rangeStatus = (value: number, [low, high]: readonly [number, number]): RangeStatus =>
	value < low ? 'below' : value > high ? 'above' : 'within';

/** The rows largest first, equal values (and missing ones, last) by name. */
const rankRows = (rows: readonly RangeRow[]) =>
	[...rows].sort(
		(a, b) =>
			(b.value?.value ?? -Infinity) - (a.value?.value ?? -Infinity) ||
			a.label.localeCompare(b.label, 'en-GB')
	);

export function rangeModel(data: RangeBarsData): RangeModel {
	const rows = rankRows(data.rows);
	const near = rows.flatMap((r) => [r.value?.value ?? 0, r.planned?.value ?? 0, r.range[0]]);
	const reach = Math.max(0, ...near) * BRACKET_REACH;
	const scale = linearScale([...near, ...rows.map((r) => Math.min(r.range[1], reach))], 'bar');
	return {
		marks: rows.map((row) => {
			const [low, high] = row.range;
			const left = scale.at(low);
			return {
				row,
				status: row.value ? rangeStatus(row.value.value, row.range) : null,
				width: row.value ? scale.at(row.value.value) : 0,
				bracket: { left, width: scale.at(high) - left, open: high > scale.max },
				tick: row.planned ? scale.at(row.planned.value) : null
			};
		}),
		ticks: rowTicks(scale)
	};
}

const unitOf = (unit: string | undefined, text: string | null | undefined) =>
	text == null ? 'No data' : `${text}${unit ? ` ${unit}` : ''}`;

/** The table twin: a row a group, largest first; Done, Target, Planned (when any) and Status. */
export function rangeTable(data: RangeBarsData): ChartTableData {
	const planned = data.rows.some((row) => row.planned);
	const unit = data.unit;
	return {
		rowHeader: 'Muscle group',
		columns: [
			{ label: 'Done', unit },
			{ label: 'Target', unit },
			...(planned ? [{ label: 'Planned', unit }] : []),
			{ label: 'Status' }
		],
		rows: rangeModel(data).marks.map(({ row, status }) => ({
			label: row.label,
			values: [
				row.value?.text ?? null,
				`${formatTotal(row.range[0])}–${formatTotal(row.range[1])}`,
				...(planned ? [row.planned?.text ?? null] : []),
				status && RANGE_STATUS[status]
			]
		}))
	};
}

/** Row `index`'s tooltip: the table twin's cells with the unit. */
export function rangeReadout(data: RangeBarsData, index: number): RowReadout {
	const { columns, rows } = rangeTable(data);
	const row = rows[index];
	if (!row) return { heading: '', rows: [] };
	return {
		heading: row.label,
		rows: columns.map((column, i) => ({
			label: column.label,
			value: column.unit ? unitOf(column.unit, row.values[i]) : (row.values[i] ?? 'No data')
		}))
	};
}

// RPE against its target, either side of zero.

/** Within this much of the target either way, RPE is on target: the hueless midpoint. */
export const ON_TARGET_RPE = 0.5;
/** The axis reaches at least this far either side of zero, so a small miss never fills the row. */
export const DIVERGE_MIN_EXTENT = 2;

export type DivergeTone = 'below' | 'zero' | 'above';

/** Each side in words, beside the signed value; the colour only repeats them. */
export const DIVERGE_WORDS: Readonly<Record<DivergeTone, string>> = {
	below: 'Easier',
	zero: 'On target',
	above: 'Harder'
};

export interface DivergingRow {
	key: string;
	/** 'Back squat'. */
	label: string;
	actual: number | null;
	target: number | null;
}

export interface DivergingBarsData {
	title: string;
	rows: readonly DivergingRow[];
}

export interface DivergingMark {
	row: DivergingRow;
	/** Actual minus target, to one decimal; null when either is missing. */
	diff: number | null;
	tone: DivergeTone | null;
	/** The bar's start and length, from zero to the difference. */
	left: number;
	width: number;
	/** '+1.5', '−0.5', '0'. */
	text: string | null;
}

export interface DivergingModel {
	/** Where zero sits: the line every bar starts from. */
	zero: number;
	marks: DivergingMark[];
	ticks: RowTick[];
}

export const divergeTone = (diff: number): DivergeTone =>
	diff < -ON_TARGET_RPE ? 'below' : diff > ON_TARGET_RPE ? 'above' : 'zero';

/** A signed difference with a true minus sign and at most one decimal: '+1.5', '−0.5', '0'. */
export const formatSigned = (value: number) =>
	value === 0
		? '0'
		: `${value < 0 ? '−' : '+'}${Math.abs(value).toLocaleString('en-GB', { maximumFractionDigits: 1 })}`;

export function divergingModel(data: DivergingBarsData): DivergingModel {
	// The tone reads the unrounded difference (only float noise trimmed, so 2.2 − 1.7 is
	// exactly 0.5); rounding to one decimal first would call 8.54 against 8 'On target'.
	const raws = data.rows.map(({ actual, target }) =>
		actual === null || target === null ? null : Math.round((actual - target) * 1e6) / 1e6
	);
	const diffs = raws.map((raw) => (raw === null ? null : Math.round(raw * 10) / 10));
	const extent = Math.max(DIVERGE_MIN_EXTENT, ...diffs.map((d) => Math.abs(d ?? 0)));
	const scale = linearScale([-extent, extent], 'line');
	const zero = scale.at(0);
	return {
		zero,
		marks: data.rows.map((row, i) => {
			const diff = diffs[i]!;
			const raw = raws[i]!;
			const end = diff === null ? zero : scale.at(diff);
			return {
				row,
				diff,
				tone: raw === null ? null : divergeTone(raw),
				left: Math.min(zero, end),
				width: Math.abs(end - zero),
				text: diff === null ? null : formatSigned(diff)
			};
		}),
		ticks: rowTicks(scale)
	};
}

const rpe = (value: number | null) =>
	value === null ? null : value.toLocaleString('en-GB', { maximumFractionDigits: 1 });

/** The table twin: a row an exercise, as given; Actual, Target, Difference and Status. */
export function divergingTable(data: DivergingBarsData): ChartTableData {
	return {
		rowHeader: 'Exercise',
		columns: [
			{ label: 'Actual', unit: 'RPE' },
			{ label: 'Target', unit: 'RPE' },
			{ label: 'Difference', unit: 'RPE' },
			{ label: 'Status' }
		],
		rows: divergingModel(data).marks.map(({ row, tone, text }) => ({
			label: row.label,
			values: [rpe(row.actual), rpe(row.target), text, tone && DIVERGE_WORDS[tone]]
		}))
	};
}

/** Row `index`'s tooltip: the table twin's cells, 'RPE' before each number. */
export function divergingReadout(data: DivergingBarsData, index: number): RowReadout {
	const { columns, rows } = divergingTable(data);
	const row = rows[index];
	if (!row) return { heading: '', rows: [] };
	return {
		heading: row.label,
		rows: columns.map((column, i) => {
			const value = row.values[i] ?? null;
			return {
				label: column.label,
				value: value === null ? 'No data' : column.unit ? `${column.unit} ${value}` : value
			};
		})
	};
}
