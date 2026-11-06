/**
 * The sets family, strength only: set.log, set.skip, set.edit and set.delete, each addressing its
 * set by client id.
 * - A set keeps exactly what it was sent: reps, seconds or metres; a weight (an added weight on a
 *   bodyweight exercise) or an assistance; its RPE, missed reps, and whether it was a warm-up or
 *   an extra set.
 * - A create of a known id is a no-op, a deleted set included, so a replay never revives a set.
 * - An edit replaces every value and keeps where the set sits, when it was done and whether it was
 *   skipped (an edit never un-skips). A delete leaves a tombstone. An edit or a delete of a set not
 *   known yet, or already deleted, changes nothing: it waits until the set's rows arrive.
 * - e1rmKg is the server's: null on a set this device created or edited, until its rows return.
 */
import type { MutationOf, SetPlace } from '../mutations.ts';
import { onRows } from '../project.ts';
import type { MutationReducers } from '../project.ts';
import type { CanonicalSet, CanonicalWorkout } from '../protocol.ts';
import type { LoggedSet } from '../types.ts';

const placeOf = ({ position, plannedLineage, setIndex, exerciseId }: SetPlace): SetPlace => ({
	position,
	plannedLineage,
	setIndex,
	exerciseId
});

const valuesOf = (set: LoggedSet): LoggedSet => ({
	reps: set.reps,
	seconds: set.seconds,
	metres: set.metres,
	weight: set.weight,
	assistance: set.assistance,
	unit: set.unit,
	rpe: set.rpe,
	missedReps: set.missedReps,
	isWarmup: set.isWarmup,
	isExtra: set.isExtra
});

/** A set not done carries no amount, load or effort. */
const NOT_DONE = {
	reps: null,
	seconds: null,
	metres: null,
	weight: null,
	assistance: null,
	rpe: null,
	missedReps: 0,
	isWarmup: false,
	isExtra: false
} as const;

/** The rows with a new set, unless its id is known: a live set or a tombstone. */
function created(
	rows: CanonicalWorkout,
	m: MutationOf<'set.log' | 'set.skip'>,
	set: Omit<CanonicalSet, 'id' | 'e1rmKg' | 'performedAt' | 'deletedAt'>
): CanonicalWorkout {
	if (rows.sets.some((s) => s.id === m.entityId)) return rows;
	const row = { id: m.entityId, ...set, e1rmKg: null, performedAt: m.at, deletedAt: null };
	return { ...rows, sets: [...rows.sets, row] };
}

/** The rows with one live set changed; unchanged when the set is not known or deleted. */
function changed(
	rows: CanonicalWorkout,
	id: string,
	change: (set: CanonicalSet) => CanonicalSet
): CanonicalWorkout {
	const index = rows.sets.findIndex((s) => s.id === id);
	const set = rows.sets[index];
	if (!set || set.deletedAt !== null) return rows;
	const next = change(set);
	return { ...rows, sets: rows.sets.map((s, i) => (i === index ? next : s)) };
}

export const sets: MutationReducers<'set.log' | 'set.skip' | 'set.edit' | 'set.delete'> = {
	'set.log': onRows((rows, m) =>
		created(rows, m, { ...placeOf(m.payload), ...valuesOf(m.payload), isSkipped: false })
	),
	'set.skip': onRows((rows, m) =>
		created(rows, m, { ...placeOf(m.payload), ...NOT_DONE, unit: m.payload.unit, isSkipped: true })
	),
	'set.edit': onRows((rows, m) =>
		changed(rows, m.entityId, (set) => ({ ...set, ...valuesOf(m.payload), e1rmKg: null }))
	),
	'set.delete': onRows((rows, m) =>
		changed(rows, m.entityId, (set) => ({ ...set, deletedAt: m.at }))
	)
};
