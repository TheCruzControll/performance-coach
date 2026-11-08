/**
 * Fix for a session's values: a refused other.log opens the session's fields (type, duration,
 * RPE, metrics, notes) with the server's errors at their fields, a metric's at that metric
 * (OtherFixSheet.svelte, loaded only then). Save re-queues the corrected change under its id.
 */
import type { FamilyFixes } from './registry.ts';

export const fixes: FamilyFixes<'other.log'> = {
	'other.log': {
		kind: 'editor',
		editor: () => import('./OtherFixSheet.svelte'),
		discard: 'Discard keeps the session as the server has it.'
	}
};
