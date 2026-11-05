/**
 * Estimated one-rep max (e1RM).
 *
 * An estimate is never a measured max: results carry `kind: 'estimated'` and the method used,
 * so the data model and the coach can keep measured and estimated 1RMs apart (PRD §3).
 *
 * A recorded RPE is information about effort and is never silently dropped. When it cannot be
 * used reliably the estimate says so (lower confidence) or there is no estimate at all (null),
 * so an easier set can never produce a *lower* e1RM than a harder one with the same weight and
 * reps.
 */
import { isValidRpe, percentOfOneRepMax, repsInReserve } from './rpe';

/**
 * - `rpe-table`: the RTS percentage chart (reps 1–12 × RPE 6–10).
 * - `reps-to-failure`: RPE recorded but the set has more reps than the chart covers; the formula
 *   mean is applied to reps + reps in reserve. Always `low` confidence.
 * - `formula-mean`: mean of Epley and Brzycki for a set **without** an RPE, assuming it went to
 *   failure (so it is a floor when the set stopped short).
 * - `single`: a 1-rep set without an RPE (the load itself, again a floor).
 */
export type E1rmMethod = 'rpe-table' | 'reps-to-failure' | 'formula-mean' | 'single';

export interface E1rmEstimate {
	kind: 'estimated';
	value: number;
	method: E1rmMethod;
	/** How far the estimate extrapolates and how much is known about the set's effort. */
	confidence: 'high' | 'medium' | 'low';
}

export interface SetPerformance {
	/** Load lifted (any unit; the estimate is returned in the same unit). */
	weight: number;
	reps: number;
	/** Actual RPE if recorded (1–10). */
	rpe?: number | null;
}

/** Beyond this many reps to failure every formula diverges too far to be useful. */
export const MAX_REPS_TO_FAILURE = 20;

/** Epley: w × (1 + r/30). Conventionally e1RM = w for a single. */
export function epley(weight: number, reps: number): number {
	if (reps <= 1) return weight;
	return weight * (1 + reps / 30);
}

/** Brzycki: w × 36 / (37 − r). Valid for r < 37; best below ~10 reps. */
export function brzycki(weight: number, reps: number): number {
	if (reps <= 1) return weight;
	if (reps >= 37) throw new RangeError('Brzycki is undefined for 37+ reps');
	return (weight * 36) / (37 - reps);
}

/** Mean of Epley and Brzycki; `reps` may be fractional (reps + reps in reserve). */
function formulaMean(weight: number, reps: number): number {
	return reps <= 1 ? weight : (epley(weight, reps) + brzycki(weight, reps)) / 2;
}

function confidenceFor(repsToFailure: number): E1rmEstimate['confidence'] {
	if (repsToFailure <= 5) return 'high';
	if (repsToFailure <= 10) return 'medium';
	return 'low';
}

const CONFIDENCE_ORDER = ['low', 'medium', 'high'] as const;

function capConfidence(
	confidence: E1rmEstimate['confidence'],
	cap: E1rmEstimate['confidence']
): E1rmEstimate['confidence'] {
	return CONFIDENCE_ORDER[
		Math.min(CONFIDENCE_ORDER.indexOf(confidence), CONFIDENCE_ORDER.indexOf(cap))
	]!;
}

/**
 * Estimate a 1RM from a single set.
 *
 * With an RPE recorded:
 * - reps 1–12 and RPE 6–10 in half steps → `rpe-table` (accounts for reps in reserve);
 * - more than 12 reps at a valid RPE → `reps-to-failure`, confidence `low`;
 * - an RPE below 6, above 10, or not on a half step → **null**. Below RPE 6 the reps-in-reserve
 *   judgement is too unreliable to be data (see rpe.ts); a malformed RPE is an input error.
 *
 * Without an RPE: the formula mean, assuming the set went to failure. Confidence is capped at
 * `medium` because the set's effort is unknown.
 *
 * Returns null for unusable input (no weight, no reps, or more than 20 reps to failure).
 */
export function estimateOneRepMax(set: SetPerformance): E1rmEstimate | null {
	const { weight, reps, rpe } = set;
	if (!(weight > 0) || !Number.isInteger(reps) || reps < 1) return null;

	if (rpe != null) {
		if (!isValidRpe(rpe)) return null;
		const repsToFailure = reps + repsInReserve(rpe);
		const pct = percentOfOneRepMax(reps, rpe);
		if (pct) {
			return {
				kind: 'estimated',
				value: weight / pct,
				method: 'rpe-table',
				confidence: confidenceFor(repsToFailure)
			};
		}
		if (repsToFailure > MAX_REPS_TO_FAILURE) return null;
		return {
			kind: 'estimated',
			value: formulaMean(weight, repsToFailure),
			method: 'reps-to-failure',
			confidence: 'low'
		};
	}

	if (reps > MAX_REPS_TO_FAILURE) return null;
	return {
		kind: 'estimated',
		value: formulaMean(weight, reps),
		method: reps === 1 ? 'single' : 'formula-mean',
		confidence: capConfidence(confidenceFor(reps), 'medium')
	};
}

/**
 * Load for a target set given a 1RM: e.g. 5 reps @ RPE 8 from a 180 kg e1RM.
 * Returns null when the reps/RPE combination is outside the table.
 */
export function loadForTarget(oneRepMax: number, reps: number, rpe: number): number | null {
	const pct = percentOfOneRepMax(reps, rpe);
	return pct ? oneRepMax * pct : null;
}
