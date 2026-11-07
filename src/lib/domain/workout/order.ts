/**
 * The order the outbox and the server keep (the offline workout sync ADR): which queued mutation
 * must wait for which. Kept apart from mutations.ts, which every workout page loads first, because
 * only the sync engine (loaded on idle) and the server use it: in mutations.ts it would add about
 * 0.25 KB gzip to the workout pages' initial JavaScript.
 */
import { entityKey } from './mutations.ts';
import type { EntityKey, Mutation } from './mutations.ts';

/** Every entity a mutation touches, and whether it creates that row. */
function touches(m: Mutation): { key: EntityKey; creates: boolean }[] {
	const key = entityKey(m);
	const own = { key, creates: m.id === m.entityId && !key.startsWith('slot:') };
	if (m.type !== 'exercise.skip') return [own];
	return [own, ...m.payload.sets.map((s) => ({ key: `set:${s.id}` as const, creates: true }))];
}

/** The exercises a mutation names, any of which may be a custom one still in the outbox. */
function exercisesOf(m: Mutation): string[] {
	switch (m.type) {
		case 'set.log':
		case 'set.skip':
		case 'exercise.skip':
		case 'pain.report':
			return [m.payload.exerciseId];
		case 'exercise.substitute':
		case 'exercise.dislike':
			return [m.payload.fromExerciseId, m.payload.toExerciseId];
		default:
			return [];
	}
}

/**
 * Whether `a` must wait for `b`, queued before it: b starts a's workout; b is an earlier change to
 * a row, record or slot a touches (a row's create waits for nothing of its own); b creates a
 * custom exercise a names; or b is the substitution a's pain report names.
 */
export function dependsOn(a: Mutation, b: Mutation): boolean {
	if (a.id === b.id || a.type === 'workout.start') return false;
	if (b.type === 'workout.start') return b.workoutId === a.workoutId;
	const touched = new Set(touches(b).map((t) => t.key));
	if (touches(a).some((t) => !t.creates && touched.has(t.key))) return true;
	if (b.type === 'exercise.create') return exercisesOf(a).includes(b.entityId);
	return (
		a.type === 'pain.report' &&
		a.payload.substitutionId === b.entityId &&
		(b.type === 'exercise.substitute' || b.type === 'exercise.dislike')
	);
}
