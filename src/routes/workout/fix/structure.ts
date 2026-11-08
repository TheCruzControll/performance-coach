/**
 * Fix for changes to an exercise's place in the workout (the M4 plan's decision on Fix):
 * - a refused swap (exercise.substitute) reopens the alternatives with why it was refused
 *   (SubstituteFixSheet.svelte, loaded only then); the one chosen is re-queued under its id
 * - a refused dislike offers 'Just swap it today': the same change, under its id, as today's
 *   swap only (JUST_SWAP_REASON), with no preference and no program change
 * - a refused Skip exercise can only be discarded, which keeps the exercise
 */
import type { MutationOf } from '#lib/domain/workout/index.ts';
import { JUST_SWAP_REASON } from '#lib/domain/workout/substitution.ts';
import type { FamilyFixes } from './registry.ts';

/** A refused dislike as today's swap only, under its id. */
export function justSwap(m: MutationOf<'exercise.dislike'>): MutationOf<'exercise.substitute'> {
	const { position, plannedLineage, fromExerciseId, toExerciseId } = m.payload;
	const payload = { position, plannedLineage, fromExerciseId, toExerciseId };
	return { ...m, type: 'exercise.substitute', payload: { ...payload, reason: JUST_SWAP_REASON } };
}

export const fixes: FamilyFixes<'exercise.skip' | 'exercise.substitute' | 'exercise.dislike'> = {
	'exercise.skip': { kind: 'discard-only', discard: 'Discard keeps the exercise.' },
	'exercise.substitute': {
		kind: 'editor',
		editor: () => import('./SubstituteFixSheet.svelte'),
		discard: 'Discard keeps the planned exercise.'
	},
	'exercise.dislike': {
		kind: 'rewrite',
		label: 'Just swap it today',
		rewrite: (m) => (m.type === 'exercise.dislike' ? justSwap(m) : m),
		discard: 'Discard keeps the exercise, in the plan and in your preferences.'
	}
};
