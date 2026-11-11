/**
 * Fix for the workout's own changes. A refused start (its planned session is gone, say) can be
 * kept as a session not linked to the plan: the same id, no planned session. A refused update or
 * finish opens the summary (FinishSheet.svelte, loaded only then) with the refused duration,
 * session RPE and notes and the server's errors; Save re-queues it under its id. Discard of a
 * start that kept failing ends the workout as abandoned instead of deleting it (abandonWords).
 */
import type { Mutation } from '#lib/domain/workout/index.ts';
import type { FamilyFixes } from './registry.ts';

const editor = () => import('../FinishSheet.svelte');

/** workout.start, kept with no planned session, program or lineage. */
function unplanned(m: Mutation): Mutation {
	if (m.type !== 'workout.start') return m;
	const payload = { ...m.payload, plannedSessionId: null, plannedLineage: null, programId: null };
	return { ...m, payload };
}

/**
 * What Discard of a stuck start says (the store's discardAbandons): the start may have reached the
 * server, so the workout stays, abandoned, and only the `n` changes logged in it go.
 */
export function abandonWords(n: number): string {
	if (n === 0) return 'Discard ends this workout as abandoned.';
	const changes = n === 1 ? '1 change' : `${n} changes`;
	return `Discard ends this workout as abandoned and removes the ${changes} logged in it.`;
}

export const fixes: FamilyFixes<
	'workout.start' | 'workout.update' | 'workout.finish' | 'workout.abandon'
> = {
	'workout.start': {
		kind: 'rewrite',
		label: 'Keep it as a session not linked to the plan',
		rewrite: unplanned,
		discard: 'Discard removes this workout and everything logged in it.'
	},
	'workout.update': {
		kind: 'editor',
		editor,
		discard: 'Discard keeps the notes and effort the server has.'
	},
	'workout.finish': {
		kind: 'editor',
		editor,
		discard: 'Discard leaves the workout unfinished.'
	},
	'workout.abandon': { kind: 'discard-only', discard: 'Discard keeps the workout.' }
};
