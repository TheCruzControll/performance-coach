/**
 * Up next (PRD §7; the M4 plan's logging rules): what the strength view names after the current
 * exercise, by flow.ts's rules. Its own module, apart from afterSet, so it loads with the view's
 * navigation, after the first render, and stays out of /workout's initial JavaScript.
 */
import { currentExercise } from './selectors.ts';
import { firstToDo, filledOf, groups, runsOf, SUPERSET_FLOW, toDo, turn } from './flow.ts';
import type { Filled, FlowOptions } from './flow.ts';
import type { KitSet, SlotView, WorkoutView } from './types.ts';

export interface UpNext {
	position: number;
	setIndex: number;
	exerciseId: string;
	label: string | null;
	/** The current exercise's superset partner, rather than the next exercise or superset. */
	partner: boolean;
	/** Its first target: the planned set it starts with; null for an added exercise. */
	target: KitSet | null;
}

/**
 * What the screen names as Up next from the current exercise: inside a superset, the partner the
 * alternation goes to once its next set is done; else the next exercise or superset with a set
 * left, then any left before it; null when nothing else is left.
 */
export function upNext(
	view: WorkoutView,
	options: Omit<FlowOptions, 'defaults'> = {}
): UpNext | null {
	const { supersets = SUPERSET_FLOW } = options;
	const current = currentExercise(view);
	if (!current) return null;
	const labels = new Map(
		groups({ exercises: view.slots }).flatMap((g) =>
			g.members.map((m) => [m.position, m.label] as const)
		)
	);
	const entry = (slot: SlotView, filled: Filled, partner: boolean): UpNext => {
		const setIndex = toDo(slot, filled)!;
		const target = slot.kit?.sets[setIndex - 1] ?? null;
		const label = labels.get(slot.position) ?? null;
		return {
			position: slot.position,
			setIndex,
			exerciseId: slot.exerciseId,
			label,
			partner,
			target
		};
	};
	const units = supersets === 'alternate' ? runsOf(view.slots) : view.slots.map((s) => [s]);
	const at = units.findIndex((unit) => unit.includes(current));
	const unit = units[at]!;
	if (unit.length > 1) {
		const index = toDo(current);
		const plus: Filled =
			index === null
				? filledOf
				: (s) => new Set([...filledOf(s), ...(s === current ? [index] : [])]);
		const { slot } = turn(unit, current, plus);
		if (slot && slot !== current) return entry(slot, plus, true);
	}
	for (const other of [...units.slice(at + 1), ...units.slice(0, at)]) {
		const slot = firstToDo(other);
		if (slot) return entry(slot, filledOf, false);
	}
	return null;
}
