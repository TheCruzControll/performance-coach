/**
 * Estimated one-rep max (e1RM).
 *
 * An estimate is never a measured max: results carry `kind: 'estimated'` and the method used,
 * so the data model and the coach can keep measured and estimated 1RMs apart (PRD §3).
 */
import { percentOfOneRepMax } from './rpe';

/** `formula-mean` = mean of Epley and Brzycki; `single` = a 1-rep set without an RPE. */
export type E1rmMethod = 'rpe-table' | 'formula-mean' | 'single';

export interface E1rmEstimate {
	kind: 'estimated';
	value: number;
	method: E1rmMethod;
	/** Lower for high-rep sets where every formula diverges. */
	confidence: 'high' | 'medium' | 'low';
}

export interface SetPerformance {
	/** Load lifted (any unit; the estimate is returned in the same unit). */
	weight: number;
	reps: number;
	/** Actual RPE if recorded (1–10). */
	rpe?: number | null;
}

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

function confidenceFor(repsToFailure: number): E1rmEstimate['confidence'] {
	if (repsToFailure <= 5) return 'high';
	if (repsToFailure <= 10) return 'medium';
	return 'low';
}

/**
 * Estimate a 1RM from a single set.
 * - With an RPE in the table range: RPE-based (accounts for reps in reserve).
 * - Otherwise: the mean of Epley and Brzycki, assuming the set went to (or near) failure.
 * Returns null for unusable input (no weight, no reps, or more than 20 reps).
 */
export function estimateOneRepMax(set: SetPerformance): E1rmEstimate | null {
	const { weight, reps, rpe } = set;
	if (!(weight > 0) || !Number.isInteger(reps) || reps < 1 || reps > 20) return null;

	if (rpe != null) {
		const pct = percentOfOneRepMax(reps, rpe);
		if (pct) {
			return {
				kind: 'estimated',
				value: weight / pct,
				method: 'rpe-table',
				confidence: confidenceFor(reps + (10 - rpe))
			};
		}
	}

	const value = reps === 1 ? weight : (epley(weight, reps) + brzycki(weight, reps)) / 2;
	return {
		kind: 'estimated',
		value,
		method: reps === 1 ? 'single' : 'formula-mean',
		confidence: confidenceFor(reps)
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
