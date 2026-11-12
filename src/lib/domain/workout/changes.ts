/**
 * The sync answer's changed rows (wire format v1; the offline workout sync ADR, 'Exactly once'):
 * for a workout the device says it holds the server's rows for (SyncRequest.held), a sync result
 * carries only the rows that batch's applied and duplicate changes name, as `changes`, instead of
 * the whole workout. The server cuts them with changedRows; the device folds them into the rows it
 * holds with mergeRows, so what it stores is the whole workout again.
 *
 * - A row a change names is the one it creates or edits: its own id (a set, a substitution, a pain
 *   report), the row its entityId names (an edit or delete of a set), and each skipped set of an
 *   exercise.skip. A fresh id that names no row keeps nothing.
 * - The workout row, the run and the other-session record are one row each and always come whole.
 * - The exercises are only those the kept rows name; the device keeps every one it already has.
 * Pure: imported by path on the server and in the store's write path.
 */
import type { Mutation } from './mutations.ts';
import type { CanonicalWorkout } from './protocol.ts';

/** The client ids of the rows a change creates or edits. */
export function namedRows(m: Mutation): string[] {
	const skipped = m.type === 'exercise.skip' ? m.payload.sets.map((s) => s.id) : [];
	return [m.id, m.entityId, ...skipped];
}

/** The workout's rows the ids name, with its workout row, run, other record and their exercises. */
export function changedRows(rows: CanonicalWorkout, ids: ReadonlySet<string>): CanonicalWorkout {
	const named = <T extends { id: string }>(list: readonly T[]) => list.filter((r) => ids.has(r.id));
	const sets = named(rows.sets);
	const substitutions = named(rows.substitutions);
	const pain = named(rows.pain);
	const exerciseIds = new Set([
		...sets.map((s) => s.exerciseId),
		...substitutions.flatMap((s) => [s.fromExerciseId, s.toExerciseId]),
		...pain.map((p) => p.exerciseId)
	]);
	const exercises = Object.fromEntries(
		Object.entries(rows.exercises).filter(([id]) => exerciseIds.has(id))
	);
	return { ...rows, sets, substitutions, pain, exercises };
}

/** Each row replaced in its place by the changed one with its id; a new one goes last. */
function byId<T extends { id: string }>(held: readonly T[], changed: readonly T[]): T[] {
	const next = new Map(changed.map((r) => [r.id, r]));
	const merged = held.map((r) => next.get(r.id) ?? r);
	const known = new Set(held.map((r) => r.id));
	return [...merged, ...changed.filter((r) => !known.has(r.id))];
}

/**
 * The rows the device holds with a sync answer's changed rows folded in. With none held (another
 * tab dropped them mid-request) still none: changed rows are not the whole workout, and a request
 * then asks for it whole.
 */
export function mergeRows(held: CanonicalWorkout, changes: CanonicalWorkout): CanonicalWorkout;
export function mergeRows(
	held: CanonicalWorkout | null,
	changes: CanonicalWorkout
): CanonicalWorkout | null;
export function mergeRows(
	held: CanonicalWorkout | null,
	changes: CanonicalWorkout
): CanonicalWorkout | null {
	if (!held) return null;
	return {
		...changes,
		sets: byId(held.sets, changes.sets),
		substitutions: byId(held.substitutions, changes.substitutions),
		pain: byId(held.pain, changes.pain),
		exercises: { ...held.exercises, ...changes.exercises }
	};
}
