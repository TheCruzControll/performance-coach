/**
 * Complete set and Skip set, each as one dispatch (the M4 plan's decisions on the store and the
 * flow): the set.log or set.skip of the set at hand and, in a superset, the move to the partner
 * that workout-flow names next, so the store writes both in one IndexedDB transaction or neither.
 * A skipped set advances like a logged one. Pure: the view is the one on screen, and the flow
 * reads it with the new set already in place.
 */
import { afterSet } from '#lib/domain/workout/flow.ts';
import type {
	LocalAction,
	LoggedSet,
	Mutation,
	SetPlace,
	WorkoutView
} from '#lib/domain/workout/index.ts';
import { createMutation } from '#lib/domain/workout/mutations.ts';
import { NOT_DONE } from '#lib/domain/workout/reducers/sets.ts';
import { slotAt } from '#lib/domain/workout/selectors.ts';
import type { WeightUnit } from '#lib/domain/units.ts';

export interface LoggedAction {
	mutation: Mutation;
	/** The goTo that moves to another exercise (a superset's partner); none otherwise. */
	followUps: LocalAction[];
}

function placeOf(view: WorkoutView, position: number, setIndex: number) {
	// Where the set sits: the slot's planned exercise and the exercise it performs.
	const slot = slotAt(view, position);
	if (!slot) throw new RangeError(`No exercise at position ${position}`);
	const { plannedLineage, exerciseId } = slot;
	return { slot, place: { position, plannedLineage, setIndex, exerciseId } };
}

/** The mutation with the move the flow names once its set is in the view. */
function withFollowUp(
	view: WorkoutView,
	slot: WorkoutView['slots'][number],
	mutation: Mutation,
	place: SetPlace,
	set: LoggedSet & { isSkipped: boolean }
): LoggedAction {
	const { position } = place;
	const row = {
		id: mutation.entityId,
		...place,
		...set,
		e1rmKg: null,
		performedAt: mutation.at,
		deletedAt: null,
		pending: true
	};
	// The view as it is once the set is in it: what the flow decides from.
	const after: WorkoutView = {
		...view,
		slots: view.slots.map((s) => (s === slot ? { ...s, sets: [...s.sets, row] } : s))
	};
	const { next } = afterSet(after, position);
	const moves = typeof next === 'object' && next.position !== position;
	return {
		mutation,
		followUps: moves ? [{ type: 'goTo', workoutId: view.workout.id, position: next.position }] : []
	};
}

/** The set.log of set `setIndex` at `position`, done `at`, with its follow-up. */
export function logSet(
	view: WorkoutView,
	position: number,
	setIndex: number,
	values: LoggedSet,
	at: string
): LoggedAction {
	const { slot, place } = placeOf(view, position, setIndex);
	const mutation = createMutation('set.log', {
		workoutId: view.workout.id,
		at,
		payload: { ...place, ...values }
	});
	return withFollowUp(view, slot, mutation, place, { ...values, isSkipped: false });
}

/** The set.skip of set `setIndex` at `position`, `at`, with its follow-up. */
export function skipSet(
	view: WorkoutView,
	position: number,
	setIndex: number,
	unit: WeightUnit,
	at: string
): LoggedAction {
	const { slot, place } = placeOf(view, position, setIndex);
	const mutation = createMutation('set.skip', {
		workoutId: view.workout.id,
		at,
		payload: { ...place, unit }
	});
	return withFollowUp(view, slot, mutation, place, { ...NOT_DONE, unit, isSkipped: true });
}
