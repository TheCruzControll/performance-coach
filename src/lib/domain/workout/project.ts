/**
 * The reconciliation rule (PRD §9, §15; the offline workout sync ADR): a screen shows one pure
 * function of what the device stores,
 *
 *     view = project(table, { workoutId, kit, canonical, pending, device })
 *
 * the server's rows with the outbox's mutations replayed on top in outbox order, beside this
 * device's own state. The optimistic UI (one mutation through applyMutation), a restore, other
 * tabs, other devices and every sync response all take this path, so they never disagree.
 *
 * - One reducer table per kind (reducers/tables.ts), so a route ships only its own reducers.
 * - Reducers are idempotent by entity: a create of a known client id is a no-op, a tombstone
 *   included; edits are absolute; deletes leave tombstones. So replaying a mutation the server
 *   already applied changes nothing, and a change to a row not known yet waits without throwing.
 * - A mutation changes only the rows; a device action only the kit and the device state.
 * - Sets show in (position, setIndex, performedAt, id) order, whatever order the rows came in.
 * These are the ADR's rules: change them only together with it.
 */
import type { SessionKind } from '../training/types.ts';
import { entityKey } from './mutations.ts';
import type { EntityKey, LocalAction, Mutation, MutationOf, MutationType } from './mutations.ts';
import type { MutationTypeFor } from './mutations.ts';
import type { CanonicalSet, CanonicalWorkout } from './protocol.ts';
import { initialDevice } from './reducers/device.ts';
import type { DeviceState, ExerciseSummary, KitExercise, SlotView, StartKit } from './types.ts';
import type { WorkoutView } from './types.ts';

// ---- Reducer tables -------------------------------------------------------------------------

/** The server's rows with mutations applied: null until a workout.start or the server has it. */
export type Rows = CanonicalWorkout | null;

export type MutationReducer<T extends MutationType> = (rows: Rows, m: MutationOf<T>) => Rows;
export type MutationReducers<T extends MutationType> = { readonly [K in T]: MutationReducer<K> };

/** What a device action may change: the kit this device holds, and its own state. */
export interface LocalState {
	kit: StartKit | null;
	device: DeviceState;
}

export type LocalType = LocalAction['type'];
export type LocalReducer<T extends LocalType> = (
	local: LocalState,
	action: LocalAction & { type: T }
) => LocalState;
export type LocalReducers = { readonly [T in LocalType]: LocalReducer<T> };

/** The rows a mutation still in the outbox touches. */
export type Pending = ReadonlySet<EntityKey>;

/** A strength slot as the structure family reads it from the rows: its substitution and state. */
export type SlotReducer = (slot: SlotView, rows: CanonicalWorkout, pending: Pending) => SlotView;

/** One kind's reducers: a case for each of its mutation types, and the device actions. */
export interface ReducerTable<K extends SessionKind> {
	kind: K;
	mutations: MutationReducers<MutationTypeFor<K>>;
	local: LocalReducers;
	/** Strength only: the structure family's reading of each slot. */
	slot?: SlotReducer;
}

/** Any kind's table, as the store and the pages hold one. */
export type AnyTable = { [K in SessionKind]: ReducerTable<K> }[SessionKind];
type AnyReducers = Partial<Record<MutationType, MutationReducer<MutationType>>>;

/**
 * A reducer for a workout the rows already hold; with no rows, the mutation waits. Free of side
 * effects, so a route's bundle drops the families of the tables it does not use (tables.ts).
 */
export const onRows =
	/* #__NO_SIDE_EFFECTS__ */
	<T extends MutationType>(
			reduce: (rows: CanonicalWorkout, m: MutationOf<T>) => CanonicalWorkout
		): MutationReducer<T> =>
		(rows, m) =>
			rows && reduce(rows, m);

// ---- The projection -------------------------------------------------------------------------

/** What the device stores for one workout, with its outbox entries. */
export interface WorkoutInputs {
	/** The workout's client id: its workout.start's id. */
	workoutId: string;
	kit: StartKit | null;
	/** The server's rows, keyed by client ids, tombstones included; null until it has any. */
	canonical: CanonicalWorkout | null;
	/** The outbox's mutations in outbox order; another workout's change nothing. */
	pending: readonly Mutation[];
	/** This device's own state; a fresh one when left out. */
	device?: DeviceState;
}

/** The inputs folded: what the reducers keep and viewOf renders. */
export interface WorkoutState extends LocalState {
	workoutId: string;
	rows: Rows;
	pending: Pending;
}

/** The rows a mutation touches: an exercise.skip also creates a skipped set for each it names. */
const touched = (m: Mutation): EntityKey[] =>
	m.type === 'exercise.skip'
		? [entityKey(m), ...m.payload.sets.map((s) => `set:${s.id}` as const)]
		: [entityKey(m)];

/** One mutation through its kind's reducer, its rows marked pending; another workout's is ignored. */
export function applyMutation(table: AnyTable, state: WorkoutState, m: Mutation): WorkoutState {
	if (m.workoutId !== state.workoutId) return state;
	const reduce = (table.mutations as AnyReducers)[m.type];
	const pending = new Set([...state.pending, ...touched(m)]);
	return { ...state, rows: reduce ? reduce(state.rows, m) : state.rows, pending };
}

/** One device action; the same state when it changes nothing or names another workout. */
export function applyLocal(
	table: AnyTable,
	state: WorkoutState,
	action: LocalAction
): WorkoutState {
	if (action.workoutId !== state.workoutId) return state;
	const reduce = table.local[action.type] as LocalReducer<LocalType>;
	const { kit, device } = reduce({ kit: state.kit, device: state.device }, action);
	return kit === state.kit && device === state.device ? state : { ...state, kit, device };
}

/** The inputs folded: the canonical rows with every pending mutation applied, in order. */
export function replay(table: AnyTable, inputs: WorkoutInputs): WorkoutState {
	const { workoutId, kit, canonical, pending, device = initialDevice() } = inputs;
	const state: WorkoutState = { workoutId, kit, rows: canonical, pending: new Set(), device };
	return pending.reduce((s, m) => applyMutation(table, s, m), state);
}

/** What the screen shows; null while no rows hold the workout. */
export function project(table: AnyTable, inputs: WorkoutInputs): WorkoutView | null {
	return viewOf(table, replay(table, inputs));
}

// ---- The view -------------------------------------------------------------------------------

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const bySetOrder = (a: CanonicalSet, b: CanonicalSet) =>
	a.position - b.position ||
	a.setIndex - b.setIndex ||
	Date.parse(a.performedAt) - Date.parse(b.performedAt) ||
	compareText(a.id, b.id);

/** A folded state as the screens render it, with what is still pending marked. */
export function viewOf(table: AnyTable, state: WorkoutState): WorkoutView | null {
	const { rows, pending, workoutId } = state;
	if (!rows) return null;
	const run = rows.run && {
		...rows.run,
		pending: pending.has(`run:${workoutId}`),
		segments: [...rows.run.segments]
			.sort((a, b) => a.position - b.position || compareText(a.id, b.id))
			.map((s) => ({ ...s, pending: pending.has(`segment:${s.id}`) }))
	};
	return {
		workout: { ...rows.workout, pending: pending.has(`workout:${workoutId}`) },
		kit: state.kit,
		slots: slotsOf(table, state, rows),
		run,
		other: rows.other && { ...rows.other, pending: pending.has(`other:${workoutId}`) },
		exercises: exercisesOf(state, rows),
		device: state.device
	};
}

/**
 * A strength workout's slots by position: the kit's, those added on this device, then any other
 * position its live sets name (an exercise added on another device, or no kit yet).
 */
function slotsOf(table: AnyTable, state: WorkoutState, rows: CanonicalWorkout): SlotView[] {
	if (rows.workout.kind !== 'strength') return [];
	const slots = new Map<number, SlotView>();
	const add = (
		position: number,
		plannedLineage: string | null,
		exerciseId: string,
		kit: KitExercise | null = null,
		superset: number | null = null
	) => {
		if (slots.has(position)) return;
		const planned = kit !== null || plannedLineage !== null;
		const slot = { position, plannedLineage, superset, exerciseId, kit, substitution: null };
		slots.set(position, { ...slot, state: planned ? 'planned' : 'added', sets: [] });
	};
	for (const e of state.kit?.kind === 'strength' ? state.kit.exercises : []) {
		add(e.position, e.plannedLineage, e.exercise.id, e, e.superset);
	}
	for (const { position, exercise } of state.device.added) add(position, null, exercise.id);
	for (const set of rows.sets.filter((s) => s.deletedAt === null).sort(bySetOrder)) {
		add(set.position, set.plannedLineage, set.exerciseId);
		slots.get(set.position)!.sets.push({ ...set, pending: state.pending.has(`set:${set.id}`) });
	}
	return [...slots.values()]
		.sort((a, b) => a.position - b.position)
		.map((slot) => (table.slot ? table.slot(slot, rows, state.pending) : slot));
}

/** Every exercise the screens may name: the kit's and its options, this device's, the rows'. */
function exercisesOf({ kit, device }: WorkoutState, rows: CanonicalWorkout) {
	const map: Record<string, ExerciseSummary> = {};
	const put = ({ id, name, measure, loadType, unilateral }: ExerciseSummary & { id: string }) => {
		map[id] = { name, measure, loadType, unilateral };
	};
	for (const e of kit?.kind === 'strength' ? kit.exercises : []) {
		put(e.exercise);
		for (const option of e.alternatives ?? []) put(option.exercise);
		for (const options of Object.values(e.gentler ?? {})) options?.forEach((o) => put(o.exercise));
	}
	for (const { exercise } of device.added) put(exercise);
	return { ...map, ...rows.exercises };
}
