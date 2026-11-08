/** Fix for a pain report: Discard only, until pain-flow. */
import type { FamilyFixes } from './registry.ts';

export const fixes: FamilyFixes<'pain.report'> = {
	'pain.report': { kind: 'discard-only', discard: 'Discard removes this pain report.' }
};
