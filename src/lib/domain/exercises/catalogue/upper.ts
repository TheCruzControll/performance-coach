/**
 * Catalogue part 2 (m3/06): bench and overhead pressing, push-ups and dips, rows, pull-ups and
 * pulldowns, delts and arms, carries, core and neck work, and upper-body mobility.
 * Columns: ../format.ts.
 */
import { parseTable } from '../format.ts';
import type { SubstitutionGroups } from '../format.ts';

/** This part's substitution groups: key → the training intent every member preserves. */
export const groups: SubstitutionGroups = {};

export const exercises = parseTable(
	'src/lib/domain/exercises/catalogue/upper.ts',
	`
key | name | aliases | pattern | primary | secondary | equipment | group | skill | reps | seconds | uni | measure/load | tags | disciplines | lift
`
);
