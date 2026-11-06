/**
 * The structure family, strength only: exercise.skip, exercise.substitute, exercise.dislike and
 * pain.report, and what they make of a slot. substitution.ts says what each quick action means.
 * - exercise.skip creates a skipped set for each client id it names, as set.skip does.
 * - exercise.substitute and exercise.dislike create today's substitution under their client id; a
 *   dislike's has reason dislike, and its note belongs to the preference, which no row here holds.
 * - pain.report creates the report under its client id, at the mutation's time.
 * - A create of a known id (a tombstone included) changes nothing, so a replay never does.
 *
 * structureSlot reads each slot from its live rows, whatever order they came in:
 * - Its exercise: the planned one, followed through the slot's substitutions, each from the
 *   exercise performed until then (ties by id). Back where it started, it shows no swap.
 * - Its state, the first that holds: stopped (a pain report stopped the exercise or the workout);
 *   skipped (every planned set has a row, and none was done); won't be prescribed (its latest
 *   substitution is a dislike's); swapped; else as the projection built it.
 */
import type { MutationOf } from '../mutations.ts';
import { onRows } from '../project.ts';
import type { MutationReducers, SlotReducer } from '../project.ts';
import type { CanonicalSubstitution, CanonicalWorkout } from '../protocol.ts';
import { DISLIKE_REASON, STOPPING_PAIN_ACTIONS, unfinishedSets } from '../substitution.ts';
import type { SlotState, SlotView } from '../types.ts';
import { NOT_DONE } from './sets.ts';

function skipped(rows: CanonicalWorkout, m: MutationOf<'exercise.skip'>): CanonicalWorkout {
	const { position, plannedLineage, exerciseId, unit } = m.payload;
	const known = new Set(rows.sets.map((s) => s.id));
	const added = m.payload.sets.flatMap(({ id, setIndex }) => {
		if (known.has(id)) return [];
		known.add(id);
		const place = { position, plannedLineage, setIndex, exerciseId };
		const set = { ...place, ...NOT_DONE, unit, isSkipped: true, e1rmKg: null };
		return [{ id, ...set, performedAt: m.at, deletedAt: null }];
	});
	return added.length ? { ...rows, sets: [...rows.sets, ...added] } : rows;
}

function substituted(
	rows: CanonicalWorkout,
	m: MutationOf<'exercise.substitute' | 'exercise.dislike'>
): CanonicalWorkout {
	if (rows.substitutions.some((s) => s.id === m.entityId)) return rows;
	const { position, plannedLineage, fromExerciseId, toExerciseId } = m.payload;
	const reason = m.type === 'exercise.dislike' ? DISLIKE_REASON : m.payload.reason;
	const row = { id: m.entityId, position, plannedLineage, fromExerciseId, toExerciseId, reason };
	return { ...rows, substitutions: [...rows.substitutions, { ...row, deletedAt: null }] };
}

export const structure: MutationReducers<
	'exercise.skip' | 'exercise.substitute' | 'exercise.dislike' | 'pain.report'
> = {
	'exercise.skip': onRows(skipped),
	'exercise.substitute': onRows((rows, m) => substituted(rows, m)),
	'exercise.dislike': onRows((rows, m) => substituted(rows, m)),
	'pain.report': onRows((rows, { entityId: id, at, payload: p }) => {
		if (rows.pain.some((r) => r.id === id)) return rows;
		const { position, plannedLineage, exerciseId, area, severity, action } = p;
		const report = { position, plannedLineage, exerciseId, area, severity, action };
		const row = { id, ...report, substitutionId: p.substitutionId, note: p.note };
		return { ...rows, pain: [...rows.pain, { ...row, reportedAt: at, deletedAt: null }] };
	})
};

/** The last of a slot's substitutions, followed from the exercise it started with. */
function latest(start: string, substitutions: readonly CanonicalSubstitution[]) {
	const left = [...substitutions].sort((a, b) => (a.id < b.id ? -1 : 1));
	let last: CanonicalSubstitution | null = null;
	for (let next = left.findIndex((s) => s.fromExerciseId === start); next >= 0;) {
		const taken: CanonicalSubstitution = left.splice(next, 1)[0]!;
		last = taken;
		next = left.findIndex((s) => s.fromExerciseId === taken.toExerciseId);
	}
	return last;
}

/** A slot's own exercise: the planned one; without a kit, the one no substitution led to. */
function startOf(slot: SlotView, substitutions: readonly CanonicalSubstitution[]) {
	if (slot.kit) return slot.kit.exercise.id;
	const reached = new Set(substitutions.map((s) => s.toExerciseId));
	const roots = substitutions.map((s) => s.fromExerciseId).filter((id) => !reached.has(id));
	return roots.sort()[0] ?? slot.exerciseId;
}

/** The first state that holds, as the header lists them. */
function stateOf(slot: SlotView, last: CanonicalSubstitution | null, ended: boolean): SlotState {
	if (ended) return 'stopped';
	const nothingDone = slot.sets.length > 0 && slot.sets.every((s) => s.isSkipped);
	if (nothingDone && unfinishedSets(slot).length === 0) return 'skipped';
	if (!last) return slot.state;
	return last.reason === DISLIKE_REASON ? 'wont_prescribe' : 'swapped';
}

export const structureSlot: SlotReducer = (slot, rows, pending) => {
	const here = <R extends { position: number; deletedAt: string | null }>(list: readonly R[]) =>
		list.filter((r) => r.position === slot.position && r.deletedAt === null);
	const substitutions = here(rows.substitutions);
	const start = startOf(slot, substitutions);
	const found = latest(start, substitutions);
	const last = found && found.toExerciseId !== start ? found : null;
	const ended = here(rows.pain).some((r) => STOPPING_PAIN_ACTIONS.includes(r.action));
	const state = stateOf(slot, last, ended);
	if (!last) return state === slot.state ? slot : { ...slot, state };
	const key = `slot:${rows.workout.id}:${slot.position}` as const;
	const substitution = { ...last, pending: pending.has(key) };
	return { ...slot, exerciseId: last.toExerciseId, state, substitution };
};
