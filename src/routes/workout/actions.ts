/**
 * The exercise quick actions as mutations (substitution.ts says what each one means): today's
 * swap, a confirmed dislike and Skip exercise, each for the slot at a position of the view on
 * screen. Pure, and loaded with the actions sheet, never before.
 * - A swap or a dislike creates today's substitution under its own client id, from the exercise
 *   the slot performs now to the one chosen.
 * - Skip exercise sends a skipped set for each planned set not done yet (unfinishedSets), each
 *   under its own client id, and moves on to the next exercise with something left to do.
 */
import type {
	KitAlternative,
	LocalAction,
	Mutation,
	SlotView,
	WorkoutView
} from '#lib/domain/workout/index.ts';
import { toDo } from '#lib/domain/workout/flow.ts';
import { createMutation } from '#lib/domain/workout/mutations.ts';
import { slotAt } from '#lib/domain/workout/selectors.ts';
import { QUICK_ACTIONS, rankFor, unfinishedSets } from '#lib/domain/workout/substitution.ts';
import type { QuickAction } from '#lib/domain/workout/substitution.ts';

/** The quick actions that pick an alternative first. */
export type SwapAction = Extract<
	QuickAction,
	'machine_unavailable' | 'suggest_alternative' | 'dislike'
>;

function slotOf(view: WorkoutView, position: number): SlotView {
	const slot = slotAt(view, position);
	if (!slot) throw new RangeError(`No exercise at position ${position}`);
	return slot;
}

/**
 * The kit's alternatives an action offers for a slot, in its order (rankFor), leaving out the
 * exercise the slot performs now. An added exercise has none.
 */
export function alternativesFor(slot: SlotView, action: SwapAction): KitAlternative[] {
	const reason = QUICK_ACTIONS[action].reason;
	return rankFor(reason, slot.kit?.alternatives ?? [], slot).filter(
		(a) => a.exercise.id !== slot.exerciseId
	);
}

/** Today's swap at `position` to `toExerciseId`, for Machine unavailable or an alternative. */
export function substitute(
	view: WorkoutView,
	position: number,
	toExerciseId: string,
	action: Exclude<SwapAction, 'dislike'>,
	at: string
): Mutation {
	const { plannedLineage, exerciseId } = slotOf(view, position);
	const payload = {
		position,
		plannedLineage,
		fromExerciseId: exerciseId,
		toExerciseId,
		reason: QUICK_ACTIONS[action].reason
	};
	return createMutation('exercise.substitute', { workoutId: view.workout.id, at, payload });
}

/** The confirmed dislike of what `position` performs, replaced by `toExerciseId`. */
export function dislike(
	view: WorkoutView,
	position: number,
	toExerciseId: string,
	at: string
): Mutation {
	const { plannedLineage, exerciseId } = slotOf(view, position);
	const payload = {
		position,
		plannedLineage,
		fromExerciseId: exerciseId,
		toExerciseId,
		note: null
	};
	return createMutation('exercise.dislike', { workoutId: view.workout.id, at, payload });
}

/**
 * Skip exercise at `position`: a skipped set for each planned set not done yet, and the move to
 * the next exercise with something to do (after it, else before it); none when there is none.
 */
export function skipExercise(
	view: WorkoutView,
	position: number,
	at: string,
	newId: () => string = () => crypto.randomUUID()
): { mutation: Mutation; followUps: LocalAction[] } {
	const slot = slotOf(view, position);
	const sets = unfinishedSets(slot).map((setIndex) => ({ id: newId(), setIndex }));
	const payload = {
		position,
		plannedLineage: slot.plannedLineage,
		exerciseId: slot.exerciseId,
		unit: view.kit?.units.weight ?? 'kg',
		sets
	};
	const mutation = createMutation('exercise.skip', { workoutId: view.workout.id, at, payload });
	const left = view.slots.filter((s) => s.position !== position && toDo(s) !== null);
	const next = left.find((s) => s.position > position) ?? left[0];
	const followUps: LocalAction[] = next
		? [{ type: 'goTo', workoutId: view.workout.id, position: next.position }]
		: [];
	return { mutation, followUps };
}
