/**
 * When a stored review is out of date (M6): inputsDigest hashes what a review was computed from,
 * so the service can compare a stored review's digest with today's and say 'computed before N
 * later changes'.
 *
 * It covers:
 * - every fact the review read (a set, a run, a session, a segment, a check-in), by kind and id,
 *   with its updated_at, so an edited set changes it
 * - each workout in the reviewed days with its status, so a workout completed or abandoned after
 *   the review changes it, even when it adds or removes no fact
 * - ANALYTICS_VERSION, so new definitions make every older review out of date
 *
 * The digest is FNV-1a 64 over canonical JSON (random.ts, as M3's fingerprint), sorted first, so
 * the order the facts were loaded in never changes it. It detects change; it is not a security
 * boundary. Pure and server-only at runtime, like domain/programming.
 */
import { ANALYTICS_VERSION } from '../../analytics/version.ts';
import type { WorkoutStatus } from '../../workout/types.ts';
import { canonicalJson, compareText, fnv1a64 } from '../random.ts';

/** An instant as a Date (a Drizzle row) or its text; both hash as the same ISO instant. */
type Instant = Date | string;

export interface DigestFact {
	/** What the id names ('set', 'run', 'session'): ids of different tables never collide. */
	kind: string;
	id: string;
	updatedAt: Instant;
}

export interface DigestWorkout {
	id: string;
	status: WorkoutStatus;
}

export interface DigestFacts {
	facts: readonly DigestFact[];
	workouts: readonly DigestWorkout[];
}

function instant(value: Instant): string {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) throw new RangeError(`Not an instant: ${String(value)}`);
	return date.toISOString();
}

/** The 16-hex-digit digest of `facts` at `analyticsVersion` (today's by default). */
export function inputsDigest(
	{ facts, workouts }: DigestFacts,
	analyticsVersion: number = ANALYTICS_VERSION
): string {
	const factEntries = facts
		.map((fact) => [fact.kind, fact.id, instant(fact.updatedAt)] as const)
		.sort((a, b) => compareText(a.join('\n'), b.join('\n')));
	const workoutEntries = workouts
		.map((workout) => [workout.id, workout.status] as const)
		.sort((a, b) => compareText(a.join('\n'), b.join('\n')));
	return fnv1a64(canonicalJson({ analyticsVersion, facts: factEntries, workouts: workoutEntries }));
}
