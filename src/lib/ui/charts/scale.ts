/**
 * Chart scales, pure: values to percent of the plot box, ticks a person can read, and the labels
 * of week and month slots. Nothing here knows pixels; marks get their pixel sizes from CSS
 * (marks.css), so a chart holds at any width (docs/adr/0016-hand-built-charts.md).
 */

/** At most this many value ticks on an axis: enough to read a value, few enough to stay quiet. */
export const MAX_TICKS = 5;

/** Tick steps are 1, 2 or 5 times a power of ten. */
const NICE = [1, 2, 5] as const;
/** Slack for floating-point division when snapping a value to a step (0.8 / 0.2 = 4.000…01). */
const EPSILON = 1e-9;

export interface Ticks {
	/** Ascending, evenly spaced, covering the range asked for; the first and last are the domain. */
	ticks: number[];
	step: number;
}

/** m × 10^exp without the float drift of 0.1 × 3 (exact for the steps a chart uses). */
const times = (k: number, exp: number) => (exp >= 0 ? k * 10 ** exp : k / 10 ** -exp);

/**
 * At most MAX_TICKS ticks on a 1-2-5 step covering [min, max]: 0–131 kg is 0, 50, 100, 150;
 * 0.8–1.6 is 0.8 to 1.6 by 0.2; a range across zero always has a tick at zero. A flat range is
 * widened by a tenth of its value (1 at zero) either side, so a single value sits mid-plot.
 */
export function niceTicks(min: number, max: number): Ticks {
	if (!Number.isFinite(min) || !Number.isFinite(max)) throw new RangeError('ticks need numbers');
	if (min > max) [min, max] = [max, min];
	if (min === max) {
		const pad = Math.abs(min) / 10 || 1;
		[min, max] = [min - pad, max + pad];
	}
	// No step below the raw interval can fit, so start at the power of ten just under it.
	for (let exp = Math.floor(Math.log10((max - min) / (MAX_TICKS - 1))); ; exp++) {
		for (const m of NICE) {
			const step = times(m, exp);
			const first = Math.floor(min / step + EPSILON);
			const last = Math.ceil(max / step - EPSILON);
			if (last - first + 1 > MAX_TICKS) continue;
			const ticks = [];
			for (let k = first; k <= last; k++) ticks.push(times(k * m, exp) || 0);
			return { ticks, step };
		}
	}
}

export type ScaleKind = 'bar' | 'line';

export interface LinearScale extends Ticks {
	min: number;
	max: number;
	/** A value as percent of the plot's height, 0 at `min` and 100 at `max`, clamped to 0–100. */
	at(value: number): number;
}

/**
 * The value axis for `values` (nulls are gaps). Bars always start at zero, so a column's height is
 * its value; a line gets a nice domain around its data, so a change is visible.
 */
export function linearScale(values: readonly (number | null)[], kind: ScaleKind): LinearScale {
	const data = values.filter((v): v is number => v !== null && Number.isFinite(v));
	let lo = data.length ? Math.min(...data) : 0;
	let hi = data.length ? Math.max(...data) : 1;
	if (kind === 'bar') {
		[lo, hi] = [Math.min(lo, 0), Math.max(hi, 0)];
		if (lo === hi) hi = 1;
	}
	const { ticks, step } = niceTicks(lo, hi);
	const min = ticks[0]!;
	const max = ticks.at(-1)!;
	const at = (value: number) => Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
	return { ticks, step, min, max, at };
}

/** Category slots side by side across the plot: weeks or months. */
export interface Band {
	count: number;
	/** One slot's width, in percent of the plot. */
	width: number;
	/** The centre of slot `i`, in percent of the plot. */
	center(i: number): number;
	/** Each slot's tick label. */
	labels: string[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' or 'YYYY-MM' as numbers, read as written (no time zone can move the day). */
function parts(date: string): { year: number; month: number; day: number } {
	const [year, month, day = 1] = date.split('-').map(Number);
	if (!year || !month || month > 12) throw new RangeError(`not a date: ${date}`);
	return { year, month, day };
}

function band(labels: string[]): Band {
	const width = labels.length ? 100 / labels.length : 100;
	return { count: labels.length, width, center: (i) => (i + 0.5) * width, labels };
}

/** Week slots from their Mondays ('2026-10-05'), labelled by day and month: '5 Oct'. */
export function weekBand(mondays: readonly string[]): Band {
	return band(
		mondays.map((monday) => {
			const { month, day } = parts(monday);
			return `${day} ${MONTHS[month - 1]}`;
		})
	);
}

/** Month slots ('2026-11' or '2026-11-01'): 'Nov', with the year on the first and on January. */
export function monthBand(months: readonly string[]): Band {
	return band(
		months.map((value, i) => {
			const { year, month } = parts(value);
			return i === 0 || month === 1 ? `${MONTHS[month - 1]} ${year}` : MONTHS[month - 1]!;
		})
	);
}

/**
 * Which of `count` slots get a tick label: at most `maxTicks`, evenly spaced and counted back
 * from the newest slot, which is always labelled.
 */
export function timeTicks(count: number, maxTicks = MAX_TICKS): number[] {
	const every = Math.max(1, Math.ceil(count / Math.max(1, maxTicks)));
	const picked: number[] = [];
	for (let i = count - 1; i >= 0; i -= every) picked.unshift(i);
	return picked;
}

/** A tick value in the step's precision, grouped ('1,500'), with a true minus sign ('−5'). */
export function formatTick(value: number, step: number): string {
	const decimals = Math.max(0, -Math.floor(Math.log10(step) + EPSILON));
	const rounded = Number(value.toFixed(decimals));
	const text = Math.abs(rounded).toLocaleString('en-GB', {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals
	});
	return rounded < 0 ? `−${text}` : text;
}

/**
 * The slot nearest `x` (percent) among ascending `positions`, for a pointer or a key; -1 when
 * there is none. Halfway between two, the later one wins: the newer week.
 */
export function nearestIndex(positions: readonly number[], x: number): number {
	let best = -1;
	let distance = Infinity;
	positions.forEach((position, i) => {
		const d = Math.abs(position - x);
		if (d <= distance) [best, distance] = [i, d];
	});
	return best;
}
