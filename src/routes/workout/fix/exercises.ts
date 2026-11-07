/** Fix for a new exercise of your own: Discard only, until custom-exercises-ui. */
import type { FamilyFixes } from './registry.ts';

export const fixes: FamilyFixes<'exercise.create'> = {
	'exercise.create': {
		kind: 'discard-only',
		discard: 'Discard removes the new exercise and the sets logged with it.'
	}
};
