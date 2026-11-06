/**
 * What the screens read off a projected workout (project.ts), so the logger, the side list, Up
 * next and the summary ask each question the same way. Each takes the view and changes nothing.
 */
import type { CanonicalSet } from './protocol.ts';
import type { KitSet, PreviousPerformance, SlotView, Viewed, WorkoutView } from './types.ts';

/** The slot at a 1-based position, or null. */
export function slotAt(view: WorkoutView, position: number): SlotView | null {
	return view.slots.find((slot) => slot.position === position) ?? null;
}

/** A slot's live sets, in order: none for a position with no slot. */
export function setsFor(view: WorkoutView, position: number): Viewed<CanonicalSet>[] {
	return slotAt(view, position)?.sets ?? [];
}

/** The exercise on screen: the device's position, else the first slot; null with no slots. */
export function currentExercise(view: WorkoutView): SlotView | null {
	return slotAt(view, view.device.position) ?? view.slots[0] ?? null;
}

/** The slot after the current one, by position; null after the last. */
export function nextExercise(view: WorkoutView): SlotView | null {
	const current = currentExercise(view);
	return (current && view.slots.find((slot) => slot.position > current.position)) ?? null;
}

/**
 * The previous sets of the exercise a slot performs: those attached for it on this device (a
 * substitute's or an added exercise's, null when it has none), else the kit's when the slot
 * performs its planned exercise, else null.
 */
export function previousFor(view: WorkoutView, position: number): PreviousPerformance | null {
	const slot = slotAt(view, position);
	if (!slot) return null;
	const attached = view.device.attached[slot.exerciseId];
	if (attached !== undefined) return attached;
	return slot.kit?.exercise.id === slot.exerciseId ? slot.kit.previous : null;
}

export interface Progress {
	/** The sets the plan asks for, and how many of them are logged or skipped. */
	sets: { planned: number; done: number };
	/**
	 * The slots, and how many have nothing left: every planned set logged or skipped, the slot
	 * skipped or stopped, or, for an added exercise, a first set logged.
	 */
	exercises: { total: number; done: number };
}

/** How far the workout is. Extra sets never count toward the plan. */
export function progress(view: WorkoutView): Progress {
	const result: Progress = { sets: { planned: 0, done: 0 }, exercises: { total: 0, done: 0 } };
	for (const slot of view.slots) {
		const planned = slot.kit?.sets.length ?? 0;
		const counted = slot.sets.filter((set) => !set.isExtra).length;
		const finished =
			slot.state === 'skipped' ||
			slot.state === 'stopped' ||
			(planned > 0 ? counted >= planned : slot.sets.length > 0);
		result.sets.planned += planned;
		result.sets.done += Math.min(planned, counted);
		result.exercises.total += 1;
		if (finished) result.exercises.done += 1;
	}
	return result;
}

/** A planned set and the set logged in its place, or a logged set the plan did not ask for. */
export interface PlannedSet {
	setIndex: number;
	planned: KitSet | null;
	logged: Viewed<CanonicalSet> | null;
}

/**
 * A slot's planned sets, each with the first set logged at its index, then every other logged
 * set (an extra set, or a second set at one index from two devices) by index, after the planned.
 */
export function plannedVsLogged(view: WorkoutView, position: number): PlannedSet[] {
	const slot = slotAt(view, position);
	if (!slot) return [];
	const rows: PlannedSet[] = (slot.kit?.sets ?? []).map((planned, i) => ({
		setIndex: i + 1,
		planned,
		logged: null
	}));
	const unplanned: PlannedSet[] = [];
	for (const set of slot.sets) {
		const row = rows[set.setIndex - 1];
		if (row && !row.logged) row.logged = set;
		else unplanned.push({ setIndex: set.setIndex, planned: null, logged: set });
	}
	return [...rows, ...unplanned].sort((a, b) => a.setIndex - b.setIndex);
}
