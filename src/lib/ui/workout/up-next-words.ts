/**
 * Up next in words (PRD §7): the exercise the flow names next (up-next.ts's upNext) and its first
 * target, and what the screen announces once a set is logged. Pure: the view in, words out.
 * - A new exercise names its first target with how many sets share it: '3 × 8 at RPE 7'.
 * - Inside a superset round the partner's one set: '45 s', '6–10 reps at RPE 8'.
 */
import { formatDuration } from '#lib/domain/units.ts';
import { toDo } from '#lib/domain/workout/flow.ts';
import { groups } from '#lib/domain/workout/groups.ts';
import { upNext } from '#lib/domain/workout/up-next.ts';
import { currentExercise } from '#lib/domain/workout/selectors.ts';
import type { KitSet, SlotView, WorkoutView } from '#lib/domain/workout/index.ts';
import { weightText } from './set-words.ts';

export interface UpNextWords {
	position: number;
	/** 'A2' in a superset; null for a straight exercise. */
	label: string | null;
	name: string;
	/** '3 × 8 at RPE 7', '45 s'; null when the plan sets none (an added exercise). */
	target: string | null;
}

/** Said when nothing is left to do. */
export const ALL_DONE = 'Every exercise done';

const seconds = (s: number) => (s < 60 ? `${s} s` : formatDuration(s));

const same = (a: KitSet, b: KitSet) =>
	a.repsMin === b.repsMin &&
	a.repsMax === b.repsMax &&
	a.seconds === b.seconds &&
	a.metres === b.metres &&
	a.targetRpe === b.targetRpe &&
	a.prescribedWeight?.value === b.prescribedWeight?.value &&
	a.prescribedWeight?.unit === b.prescribedWeight?.unit;

/**
 * Planned set `from` (1-based) in words, as one set (`single`) or with the run of identical sets
 * that starts with it: '3 × 8 at RPE 7', '5 reps at ≈ 100 kg', '45 s'. Null for no such set.
 */
export function targetWords(sets: readonly KitSet[], from: number, single = false): string | null {
	const set = sets[from - 1];
	if (!set) return null;
	let count = 1;
	while (!single && sets[from - 1 + count] && same(set, sets[from - 1 + count]!)) count += 1;
	const { repsMin: min, repsMax: max } = set;
	const reps = min !== null && max !== null && min !== max ? `${min}–${max}` : (min ?? max);
	const amount =
		reps !== null
			? count > 1
				? `${reps}`
				: `${reps} reps`
			: set.seconds !== null
				? seconds(set.seconds)
				: set.metres !== null
					? `${set.metres} m`
					: null;
	const base = amount && (count > 1 ? `${count} × ${amount}` : amount);
	const more = [
		set.prescribedWeight && weightText(set.prescribedWeight),
		set.targetRpe !== null ? `RPE ${set.targetRpe}` : null
	].filter(Boolean);
	if (!base) return more.join(', ') || null;
	return more.length > 0 ? `${base} at ${more.join(', ')}` : base;
}

/** What the live region says: 'Next: Romanian deadlift, 3 × 8 at RPE 7', 'Next: A2 Plank, 45 s'. */
export const nextLine = ({ label, name, target }: UpNextWords): string =>
	`Next: ${label ? `${label} ` : ''}${name}${target ? `, ${target}` : ''}`;

const labelOf = (view: WorkoutView, position: number) =>
	groups({ exercises: view.slots })
		.flatMap((g) => g.members)
		.find((m) => m.position === position)?.label ?? null;

const wordsOf = (
	view: WorkoutView,
	slot: Pick<SlotView, 'position' | 'exerciseId' | 'kit'>,
	setIndex: number,
	single: boolean
): UpNextWords => ({
	position: slot.position,
	label: labelOf(view, slot.position),
	name: view.exercises[slot.exerciseId]?.name ?? 'Exercise',
	target: targetWords(slot.kit?.sets ?? [], setIndex, single)
});

/** Up next from the current exercise, in words; null when nothing else is left. */
export function upNextWords(view: WorkoutView): UpNextWords | null {
	const next = upNext(view);
	const slot = next && view.slots.find((s) => s.position === next.position);
	return next && slot ? wordsOf(view, slot, next.setIndex, next.partner) : null;
}

/**
 * What to announce once a set is logged or skipped: the exercise the flow moved to (`moved`, a
 * superset's partner) with its one set; else, the exercise done, Up next; else nothing.
 */
export function announcement(view: WorkoutView, moved: boolean): string | null {
	const current = currentExercise(view);
	if (!current) return null;
	const index = toDo(current);
	if (index !== null) return moved ? nextLine(wordsOf(view, current, index, true)) : null;
	const next = upNextWords(view);
	return next ? nextLine(next) : ALL_DONE;
}
