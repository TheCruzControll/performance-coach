/**
 * The other family, other sessions only: other.log sets the session's fields absolutely (entity
 * other:<workout>).
 *
 * An identity stub until run-other-rules replaces this file: until then other.log changes no row.
 */
import type { MutationReducers, Rows } from '../project.ts';

const unchanged = (rows: Rows) => rows;

export const other: MutationReducers<'other.log'> = {
	'other.log': unchanged
};
