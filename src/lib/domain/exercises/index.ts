/**
 * The exercise library (PRD §5). Every database is seeded with CATALOGUE by the migrate run, and
 * the generator reads it from here, never from rows, referring to exercises by key.
 *
 * Server-only: pages never import this package at runtime (`import type` is fine). It is not
 * re-exported from src/lib/domain/index.ts. Runtime imports use explicit .ts specifiers, because
 * the seed loads it under plain Node (scripts/catalogue-node.test.ts).
 */
import * as lower from './catalogue/lower.ts';
import * as upper from './catalogue/upper.ts';
import type { CatalogueExercise, SubstitutionGroups } from './format.ts';

export type { CatalogueExercise, SubstitutionGroups } from './format.ts';

/** Every catalogue exercise, part 1 then part 2. */
export const CATALOGUE: readonly CatalogueExercise[] = [...lower.exercises, ...upper.exercises];

/** Every substitution group: key → the training intent its members preserve. */
export const SUBSTITUTION_GROUPS: SubstitutionGroups = { ...lower.groups, ...upper.groups };

export const catalogueByKey: ReadonlyMap<string, CatalogueExercise> = new Map(
	CATALOGUE.map((exercise) => [exercise.key, exercise])
);
