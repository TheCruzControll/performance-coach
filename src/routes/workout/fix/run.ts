/** Fix for a run's changes: Discard only, until run-logging. */
import type { FamilyFixes } from './registry.ts';

export const fixes: FamilyFixes<'run.log' | 'run.segment'> = {
	'run.log': { kind: 'discard-only', discard: 'Discard keeps the run as the server has it.' },
	'run.segment': { kind: 'discard-only', discard: 'Discard removes this change to the segment.' }
};
