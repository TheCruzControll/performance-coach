/**
 * How a set's values are entered, the same in the logger (SetLogger) and the set editor
 * (SetEditSheet): each amount's stepper, the m:ss a time is typed as, and what a set must have
 * before it is saved. Loaded with them, never in /workout's initial JavaScript. Pure.
 */
import type { SetFields } from '#lib/domain/workout/logging.ts';
import type { LoggedSet } from '#lib/domain/workout/index.ts';

/** Each amount's stepper: a time or a distance is at least 1 (LOG_LIMITS); 0 reps is a set. */
export const AMOUNT_STEPS = {
	reps: { min: 0, step: 1, bigStep: 5, max: 100, unit: 'reps', chars: 3 },
	seconds: { min: 1, step: 5, bigStep: 30, max: 3600, unit: undefined, chars: 5 },
	metres: { min: 1, step: 10, bigStep: 100, max: 100_000, unit: 'm', chars: 5 }
} as const;

/** The most missed reps a set records (the payload schemas' range). */
export const MISSED_REPS_MAX = 50;

/** Asked when a weighted set has none. */
export const NEEDS_WEIGHT = 'Enter the weight you used';
/** Asked when a timed or distance set has none. */
export const NEEDS_AMOUNT = { seconds: 'Enter the time', metres: 'Enter the distance' } as const;

/** '1:30' or '90' as seconds; null for anything else. */
export function parseTime(text: string): number | null {
	const match = /^(\d+)(?::(\d{1,2}))?$/.exec(text.trim());
	if (!match) return null;
	return match[2] === undefined ? Number(match[1]) : Number(match[1]) * 60 + Number(match[2]);
}

/**
 * What the set lacks before it can be saved: 'load' when a weighted set has no weight (never 0),
 * 'amount' when a time or a distance is under its minimum; null when it can be saved.
 */
export function missingInput(fields: SetFields, set: LoggedSet): 'load' | 'amount' | null {
	if (fields.load === 'weight' && !((set.weight ?? 0) > 0)) return 'load';
	if ((set[fields.amount] ?? 0) < AMOUNT_STEPS[fields.amount].min) return 'amount';
	return null;
}
