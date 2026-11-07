/** Fix for set changes: the set editor, with the refused values; a refused delete can only go. */
import type { FamilyFixes } from './registry.ts';

export const fixes: FamilyFixes<'set.log' | 'set.skip' | 'set.edit' | 'set.delete'> = {
	'set.log': { kind: 'set-editor', discard: 'Discard removes the set.' },
	'set.skip': { kind: 'set-editor', discard: 'Discard removes the skip, so you can log the set.' },
	'set.edit': { kind: 'set-editor', discard: 'Discard keeps the set as it was.' },
	'set.delete': { kind: 'discard-only', discard: 'Discard keeps the set.' }
};
