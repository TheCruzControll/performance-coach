/**
 * Fix for a run's changes: a refused run.segment opens that segment's distance, time and heart
 * rate, and a refused run.log the run's values it carries, each with the server's errors
 * (RunFixSheet.svelte, loaded only then). Save re-queues the corrected change under its id.
 */
import type { FamilyFixes } from './registry.ts';

const editor = () => import('./RunFixSheet.svelte');

export const fixes: FamilyFixes<'run.log' | 'run.segment'> = {
	'run.log': {
		kind: 'editor',
		editor,
		discard: 'Discard keeps the run as the server has it.'
	},
	'run.segment': {
		kind: 'editor',
		editor,
		discard: 'Discard removes this change to the segment.'
	}
};
