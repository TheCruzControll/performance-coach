/**
 * Complete set and Skip set, each as one dispatch (the M4 plan's decisions on the store and the
 * flow): the set.log or set.skip of the set at hand and, in a superset, the move to the partner
 * that workout-flow names next, so the store writes both in one IndexedDB transaction or neither.
 * A skipped set advances like a logged one. Pure: the view is the one on screen, and the flow
 * reads it with the new set already in place.
 * A completed set also starts the rest the flow names (after a straight set, and after a
 * superset round's last member), when the device's settings start it by itself; a skipped set
 * starts none, since nothing was done to rest from.
 */
import { afterSet } from '#lib/domain/workout/flow.ts';
import type { RestDefaults } from '#lib/domain/workout/timers.ts';
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
	/**
	 * The goTo that moves to another exercise (a superset's partner), then the rest.start of the
	 * rest that starts now; neither when there is none.
	 */
	followUps: LocalAction[];
}

/** Whether a completed set starts the rest timer, and the device's rest per class (settings.ts). */
export interface RestOptions {
	autoStart: boolean;
	defaults: Partial<RestDefaults>;
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
	set: LoggedSet & { isSkipped: boolean },
	rest: RestOptions | null = null
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
	const { next, rest: starts } = afterSet(after, position, { defaults: rest?.defaults });
	const { id: workoutId } = view.workout;
	const followUps: LocalAction[] = [];
	if (typeof next === 'object' && next.position !== position) {
		followUps.push({ type: 'goTo', workoutId, position: next.position });
	}
	if (rest?.autoStart && starts) {
		const at = Date.parse(mutation.at);
		followUps.push({ type: 'rest.start', workoutId, at, durationMs: starts.seconds * 1000 });
	}
	return { mutation, followUps };
}

/**
 * The set.log of set `setIndex` at `position`, done `at`, with its follow-ups: the move, and the
 * rest `rest` starts (none without it).
 */
export function logSet(
	view: WorkoutView,
	position: number,
	setIndex: number,
	values: LoggedSet,
	at: string,
	rest: RestOptions | null = null
): LoggedAction {
	const { slot, place } = placeOf(view, position, setIndex);
	const mutation = createMutation('set.log', {
		workoutId: view.workout.id,
		at,
		payload: { ...place, ...values }
	});
	return withFollowUp(view, slot, mutation, place, { ...values, isSkipped: false }, rest);
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
