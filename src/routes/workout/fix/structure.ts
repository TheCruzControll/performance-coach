/** Fix for changes to an exercise's place in the workout: Discard only, until substitutions. */
import type { FamilyFixes } from './registry.ts';

export const fixes: FamilyFixes<'exercise.skip' | 'exercise.substitute' | 'exercise.dislike'> = {
	'exercise.skip': { kind: 'discard-only', discard: 'Discard keeps the exercise.' },
	'exercise.substitute': { kind: 'discard-only', discard: 'Discard keeps the planned exercise.' },
	'exercise.dislike': {
		kind: 'discard-only',
		discard: 'Discard keeps the exercise, in the plan and in your preferences.'
	}
};
