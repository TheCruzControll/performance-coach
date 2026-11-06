/**
 * The structure family, strength only: exercise.skip, exercise.substitute, exercise.dislike and
 * pain.report, and what they make of a slot (swapped, won't be prescribed, skipped, stopped).
 *
 * An identity stub until substitution-rules replaces this file: until then these mutations change
 * no row, and every slot reads as the projection built it.
 */
import type { MutationReducers, Rows, SlotReducer } from '../project.ts';

const unchanged = (rows: Rows) => rows;

export const structure: MutationReducers<
	'exercise.skip' | 'exercise.substitute' | 'exercise.dislike' | 'pain.report'
> = {
	'exercise.skip': unchanged,
	'exercise.substitute': unchanged,
	'exercise.dislike': unchanged,
	'pain.report': unchanged
};

export const structureSlot: SlotReducer = (slot) => slot;
