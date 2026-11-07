/**
 * Complete set, as one dispatch (the M4 plan's decisions on the store and the flow): the set.log
 * of the set at hand and, in a superset, the move to the partner that workout-flow names next,
 * so the store writes both in one IndexedDB transaction or neither. Pure: the view is the one on
 * screen, and the flow reads it with the new set already in place.
 */
import { afterSet } from '#lib/domain/workout/flow.ts';
import type { LocalAction, LoggedSet, Mutation, WorkoutView } from '#lib/domain/workout/index.ts';
import { createMutation } from '#lib/domain/workout/mutations.ts';
import { slotAt } from '#lib/domain/workout/selectors.ts';

export interface LoggedAction {
	mutation: Mutation;
	/** The goTo that moves to another exercise (a superset's partner); none otherwise. */
	followUps: LocalAction[];
}

/** The set.log of set `setIndex` at `position`, done `at`, with its follow-up. */
export function logSet(
	view: WorkoutView,
	position: number,
	setIndex: number,
	values: LoggedSet,
	at: string
): LoggedAction {
	const slot = slotAt(view, position);
	if (!slot) throw new RangeError(`No exercise at position ${position}`);
	const workoutId = view.workout.id;
	const { plannedLineage, exerciseId } = slot;
	const mutation = createMutation('set.log', {
		workoutId,
		at,
		payload: { position, plannedLineage, setIndex, exerciseId, ...values }
	});
	// The view as it is once the set is in it: what the flow decides from.
	const row = {
		id: mutation.entityId,
		...mutation.payload,
		isSkipped: false,
		e1rmKg: null,
		performedAt: at,
		deletedAt: null,
		pending: true
	};
	const after: WorkoutView = {
		...view,
		slots: view.slots.map((s) => (s === slot ? { ...s, sets: [...s.sets, row] } : s))
	};
	const { next } = afterSet(after, position);
	const moves = typeof next === 'object' && next.position !== position;
	return {
		mutation,
		followUps: moves ? [{ type: 'goTo', workoutId, position: next.position }] : []
	};
}
