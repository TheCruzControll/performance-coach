/**
 * Fix for the workout's own changes. A refused start (its planned session is gone, say) can be
 * kept as a session not linked to the plan: the same id, no planned session. finish-workout gives
 * update and finish their editor.
 */
import type { Mutation } from '#lib/domain/workout/index.ts';
import type { FamilyFixes } from './registry.ts';

/** workout.start, kept with no planned session, program or lineage. */
function unplanned(m: Mutation): Mutation {
	if (m.type !== 'workout.start') return m;
	const payload = { ...m.payload, plannedSessionId: null, plannedLineage: null, programId: null };
	return { ...m, payload };
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
		kind: 'discard-only',
		discard: 'Discard keeps the notes and effort the server has.'
	},
	'workout.finish': { kind: 'discard-only', discard: 'Discard leaves the workout unfinished.' },
	'workout.abandon': { kind: 'discard-only', discard: 'Discard keeps the workout.' }
};
