/**
 * Catalogue part 1 (m3/05): squat, hinge, lunge and single-leg work, Olympic lifts and pulls,
 * plyometrics, lower-body machines and isolation, conditioning and lower-body mobility.
 * Columns: ../format.ts.
 */
import { parseTable } from '../format.ts';
import type { SubstitutionGroups } from '../format.ts';

/** This part's substitution groups: key → the training intent every member preserves. */
export const groups: SubstitutionGroups = {};

export const exercises = parseTable(
	'src/lib/domain/exercises/catalogue/lower.ts',
	`
key | name | aliases | pattern | primary | secondary | equipment | group | skill | reps | seconds | uni | measure/load | tags | disciplines | lift
`
);
