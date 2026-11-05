/**
 * RPE (rate of perceived exertion) for resistance training, on the 1–10 "reps in reserve"
 * scale: RPE 10 = no reps left, RPE 9 = 1 rep in reserve, RPE 8 = 2 RIR, ...
 *
 * Percent-of-1RM table: the widely used RTS/Tuchscherer chart (reps 1–12 × RPE 6–10 in half
 * steps). Values are fractions of a one-rep max.
 */

export const RPE_MIN = 6;
export const RPE_MAX = 10;
export const REPS_MAX = 12;

/** Rows: RPE 10, 9.5, 9, ..., 6. Columns: reps 1..12. */
const RPE_STEPS = [10, 9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6] as const;
const TABLE: readonly (readonly number[])[] = [
	[1.0, 0.955, 0.922, 0.892, 0.863, 0.837, 0.811, 0.786, 0.762, 0.739, 0.707, 0.68],
	[0.978, 0.939, 0.907, 0.878, 0.85, 0.824, 0.799, 0.774, 0.751, 0.723, 0.694, 0.667],
	[0.955, 0.922, 0.892, 0.863, 0.837, 0.811, 0.786, 0.762, 0.739, 0.707, 0.68, 0.653],
	[0.939, 0.907, 0.878, 0.85, 0.824, 0.799, 0.774, 0.751, 0.723, 0.694, 0.667, 0.64],
	[0.922, 0.892, 0.863, 0.837, 0.811, 0.786, 0.762, 0.739, 0.707, 0.68, 0.653, 0.626],
	[0.907, 0.878, 0.85, 0.824, 0.799, 0.774, 0.751, 0.723, 0.694, 0.667, 0.64, 0.613],
	[0.892, 0.863, 0.837, 0.811, 0.786, 0.762, 0.739, 0.707, 0.68, 0.653, 0.626, 0.599],
	[0.878, 0.85, 0.824, 0.799, 0.774, 0.751, 0.723, 0.694, 0.667, 0.64, 0.613, 0.586],
	[0.863, 0.837, 0.811, 0.786, 0.762, 0.739, 0.707, 0.68, 0.653, 0.626, 0.599, 0.572]
];

export function isValidRpe(rpe: number): boolean {
	return Number.isFinite(rpe) && rpe >= RPE_MIN && rpe <= RPE_MAX && (rpe * 2) % 1 === 0;
}

/** Reps in reserve implied by an RPE (RPE 8 → 2). */
export function repsInReserve(rpe: number): number {
	if (!Number.isFinite(rpe) || rpe < 1 || rpe > 10) throw new RangeError('RPE must be 1–10');
	return 10 - rpe;
}

/**
 * Fraction of 1RM a set of `reps` at `rpe` represents, or null when outside the table
 * (reps 1–12, RPE 6–10 in 0.5 steps). Out-of-range inputs are not extrapolated on purpose:
 * low-rep/low-RPE estimates are unreliable and the coach must not treat them as data.
 */
export function percentOfOneRepMax(reps: number, rpe: number): number | null {
	if (!Number.isInteger(reps) || reps < 1 || reps > REPS_MAX || !isValidRpe(rpe)) return null;
	const row = RPE_STEPS.indexOf(rpe as (typeof RPE_STEPS)[number]);
	return TABLE[row]?.[reps - 1] ?? null;
}
