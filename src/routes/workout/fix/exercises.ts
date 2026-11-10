/**
 * Fix for a new exercise of your own: the form (CustomExerciseSheet.svelte, loaded only then)
 * reopens with the refused exercise and the server's errors, such as a name the owner retired
 * earlier; Save re-queues it under its id, so it lands once, as the device's id, with its sets.
 */
import type { FamilyFixes } from './registry.ts';

export const fixes: FamilyFixes<'exercise.create'> = {
	'exercise.create': {
		kind: 'editor',
		editor: () => import('../CustomExerciseSheet.svelte'),
		discard: 'Discard removes the new exercise and the sets logged with it.'
	}
};
