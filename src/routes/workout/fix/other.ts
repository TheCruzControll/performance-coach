/** Fix for a session's values: Discard only, until other-logging. */
import type { FamilyFixes } from './registry.ts';

export const fixes: FamilyFixes<'other.log'> = {
	'other.log': { kind: 'discard-only', discard: 'Discard keeps the session as the server has it.' }
};
