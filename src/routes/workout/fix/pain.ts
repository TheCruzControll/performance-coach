/**
 * Fix for a pain report: the pain sheet (PainSheet.svelte, loaded only then) reopens with the
 * refused area, severity and note and the server's errors; Save re-queues the report under its
 * id. What the owner did then (stopped, a gentler option, ended the workout) stays as it was.
 */
import type { FamilyFixes } from './registry.ts';

export const fixes: FamilyFixes<'pain.report'> = {
	'pain.report': {
		kind: 'editor',
		editor: () => import('../PainSheet.svelte'),
		discard: 'Discard removes this pain report.'
	}
};
