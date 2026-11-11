/**
 * Units of measure for training data. Pure functions, no I/O.
 *
 * Storage convention (from M3): loads are stored in kilograms and distances in metres, both as
 * exact decimals; conversion happens at the edges (input and display) using exact factors.
 */

export type WeightUnit = 'kg' | 'lb';
export type DistanceUnit = 'km' | 'mi' | 'm';

/** International avoirdupois pound, exact by definition (1959). */
export const KG_PER_LB = 0.45359237;
/** International mile, exact by definition. */
export const METRES_PER_MILE = 1609.344;

export function lbToKg(lb: number): number {
	return lb * KG_PER_LB;
}

export function kgToLb(kg: number): number {
	return kg / KG_PER_LB;
}

export function convertWeight(value: number, from: WeightUnit, to: WeightUnit): number {
	if (from === to) return value;
	return from === 'kg' ? kgToLb(value) : lbToKg(value);
}

export function toMetres(value: number, unit: DistanceUnit): number {
	switch (unit) {
		case 'm':
			return value;
		case 'km':
			return value * 1000;
		case 'mi':
			return value * METRES_PER_MILE;
	}
}

export function fromMetres(metres: number, unit: DistanceUnit): number {
	switch (unit) {
		case 'm':
			return metres;
		case 'km':
			return metres / 1000;
		case 'mi':
			return metres / METRES_PER_MILE;
	}
}

export function convertDistance(value: number, from: DistanceUnit, to: DistanceUnit): number {
	return from === to ? value : fromMetres(toMetres(value, from), to);
}

/**
 * Round to the nearest multiple of `increment` (e.g. 2.5 kg, 5 lb), removing binary floating
 * point noise so 0.1 + 0.2 style artefacts never reach the UI.
 */
export function roundToIncrement(
	value: number,
	increment: number,
	mode: 'nearest' | 'down' | 'up' = 'nearest'
): number {
	if (!(increment > 0)) throw new RangeError('increment must be > 0');
	const ratio = value / increment;
	const steps =
		mode === 'down'
			? Math.floor(ratio + 1e-9)
			: mode === 'up'
				? Math.ceil(ratio - 1e-9)
				: Math.round(ratio);
	return cleanFloat(steps * increment);
}

/** Strip floating point noise (e.g. 102.49999999999999 -> 102.5). */
export function cleanFloat(value: number, decimals = 6): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

/** Smallest loadable increment for typical gym equipment in each unit. */
export const DEFAULT_LOAD_INCREMENT: Record<WeightUnit, number> = { kg: 2.5, lb: 5 };

/**
 * Pace in seconds per unit distance, from a duration (seconds) and distance (metres).
 * Returns null when the distance is zero.
 */
export function paceSecondsPer(
	durationSeconds: number,
	distanceMetres: number,
	unit: Exclude<DistanceUnit, 'm'>
): number | null {
	if (distanceMetres <= 0) return null;
	return durationSeconds / fromMetres(distanceMetres, unit);
}

/** Convert a pace between per-km and per-mile. */
export function convertPace(
	secondsPerUnit: number,
	from: Exclude<DistanceUnit, 'm'>,
	to: Exclude<DistanceUnit, 'm'>
): number {
	if (from === to) return secondsPerUnit;
	return from === 'km'
		? secondsPerUnit * (METRES_PER_MILE / 1000)
		: secondsPerUnit / (METRES_PER_MILE / 1000);
}

/**
 * Format seconds as `m:ss` or `h:mm:ss` (rounded to the nearest second).
 * Negative values are formatted with a leading minus sign.
 */
export function formatDuration(totalSeconds: number): string {
	const sign = totalSeconds < 0 ? '-' : '';
	let s = Math.round(Math.abs(totalSeconds));
	const h = Math.floor(s / 3600);
	s -= h * 3600;
	const m = Math.floor(s / 60);
	s -= m * 60;
	const ss = String(s).padStart(2, '0');
	return h > 0 ? `${sign}${h}:${String(m).padStart(2, '0')}:${ss}` : `${sign}${m}:${ss}`;
}

/** Parse `m:ss`, `mm:ss` or `h:mm:ss` into seconds. Returns null for malformed input. */
export function parseDuration(input: string): number | null {
	const match = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s*$/.exec(input);
	if (!match) return null;
	const [, h, m, s] = match;
	const minutes = Number(m);
	const seconds = Number(s);
	if (seconds >= 60 || (h !== undefined && minutes >= 60)) return null;
	return Number(h ?? 0) * 3600 + minutes * 60 + seconds;
}

/**
 * Format a weight for display: trims trailing zeros, max `decimals` places, the whole part grouped
 * in thousands as en-US writes it (`1,250 kg`). Written out, not with toLocaleString, which builds
 * an ICU number formatter on each call: a page's first one cost its first Complete set about 30 ms
 * at 4× CPU (perf-journey.e2e.ts), inside the tap's own frame.
 */
export function formatWeight(value: number, unit: WeightUnit, decimals = 2): string {
	return `${groupThousands(cleanFloat(value, decimals) + 0, decimals)} ${unit}`;
}

/** `value` (already rounded to `decimals`) with commas between thousands: `1,234.5`. */
function groupThousands(value: number, decimals: number): string {
	const digits = String(Math.abs(value));
	// Exponent notation (below 1e-6, from 1e21) and NaN or Infinity: left to the platform.
	if (!Number.isFinite(value) || digits.includes('e')) {
		return value.toLocaleString('en-US', { maximumFractionDigits: decimals });
	}
	const [whole = '', fraction] = digits.split('.');
	const grouped = whole.replace(/\B(?=(\d{3})+$)/g, ',');
	return `${value < 0 ? '-' : ''}${grouped}${fraction === undefined ? '' : `.${fraction}`}`;
}
