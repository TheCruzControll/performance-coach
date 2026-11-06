/**
 * The run family, runs only: run.log sets the run's own fields (entity run:<workout>), and
 * run.segment adds a segment on its first send and replaces its values on every later one.
 *
 * An identity stub until run-other-rules replaces this file: until then these mutations change no
 * row.
 */
import type { MutationReducers, Rows } from '../project.ts';

const unchanged = (rows: Rows) => rows;

export const run: MutationReducers<'run.log' | 'run.segment'> = {
	'run.log': unchanged,
	'run.segment': unchanged
};
