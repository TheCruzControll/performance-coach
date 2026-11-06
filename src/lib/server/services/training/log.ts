/**
 * Logging training (PRD §7, §9): starting and finishing a workout, logging, editing and deleting
 * its sets, and recording an in-workout substitution. M4's workout screens and the sync endpoint
 * that replays its offline outbox write through here, and so do the coach's tools (M5). Callers
 * import this module by path.
 *
 * The replay contract M4's outbox relies on (frozen here; m3/48 documents it):
 * - Rows are addressed by their device ids, as wire format v1 names them (the offline workout
 *   sync ADR): a workout by its client id, a set and a substitution by their client mutation
 *   ids. A device can name a row before its create has synced.
 * - Creates (startWorkout, logSet, recordSubstitution) are idempotent on that id. The first call
 *   writes the row; a replay writes nothing and returns the stored row with duplicate: true. The
 *   stored row always wins: matches says whether the replay carried the same values, so M4 can
 *   tell the owner when it did not. A replayed create of a deleted set returns its tombstone.
 * - Edits (editSet, finishWorkout) carry absolute values, never differences, so they are
 *   idempotent by value: one that changes nothing is skipped (changed: false), with no
 *   updated_at bump and no audit row. M4 applies one row's mutations in order, so an edit needs
 *   no id of its own. Editing a deleted set is refused (TrainingLogConflictError 'deleted').
 * - Deletes are soft (deleted_at). Deleting a deleted set returns it unchanged and writes nothing.
 * - Each set stores its e1RM in kg when logged (the metrics' setE1rm). An edit that changes the
 *   weight, unit, reps, RPE or the warm-up or skipped flag stores it again, so the PR and history
 *   reads never see a stale one.
 * - Each call is one transaction, a savepoint inside the caller's when deps.db is one; an edit
 *   sets app.actor to deps.source for the audit trigger.
 * - A substitution stays on the workout: it never writes an exercise preference, whatever its
 *   reason (only an explicit 'never prescribe this again' does, m3/39).
 */
import { setE1rm, type E1rmSet } from '../../../domain/training/metrics';
import {
	editSetSchema,
	finishWorkoutSchema,
	logSetSchema,
	startWorkoutSchema,
	substitutionSchema
} from '../../../domain/training/schemas';
import {
	createTrainingLogRepository,
	type SetRow,
	type Stored,
	type SubstitutionRow,
	type WorkoutEdit,
	type WorkoutRow
} from '../../db/repositories/training-log';
import type { Executor } from '../../db/types';
import { measure } from '../../observability/timing';
import { getExercisesByIds } from '../exercises/index';
import { isUuid } from '../ids';
import {
	ConflictError,
	parseWith,
	resolveDeps,
	TrainingInputError,
	TrainingNotFoundError,
	type TrainingDeps
} from './shared';

export type { SetRow, SubstitutionRow, WorkoutRow } from '../../db/repositories/training-log';

/** The row an edit names has been deleted, on another device say: nothing was written. */
export class TrainingLogConflictError extends ConflictError<'deleted'> {
	constructor() {
		super('deleted', 'the set was deleted');
		this.name = 'TrainingLogConflictError';
	}
}

/** What a create answers: duplicate for a replay, matches when it carried the stored values. */
export interface Created {
	duplicate: boolean;
	matches: boolean;
}

type Repo = ReturnType<typeof createTrainingLogRepository>;

/** Whether `row` already holds every value in `values`, instants compared by time. */
function holds<Row extends object>(row: Row, values: Partial<Row>): boolean {
	return Object.entries(values).every(([key, value]) => {
		const held: unknown = row[key as keyof Row];
		return value instanceof Date && held instanceof Date
			? value.getTime() === held.getTime()
			: value === held;
	});
}

/** The stored row's answer to a create, or a field error if another owner's row has its id. */
function answer<Row extends object>(stored: Stored<Row> | null, values: Partial<Row>, id: string) {
	if (!stored) throw new TrainingInputError({ [id]: 'Already used' });
	return { row: stored.row, duplicate: !stored.created, matches: holds(stored.row, values) };
}

/** `values` without the fields left out: what a partial edit sets. */
const given = <T extends object>(values: T) =>
	Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Partial<T>;

const e1rmOf = (set: E1rmSet) => setE1rm(set)?.value ?? null;

/** The owner's workout by its client id; deleted ones are not found. */
async function liveWorkout(repo: Repo, ownerId: string, clientId: string, lock = false) {
	const workout = isUuid(clientId) ? await repo.workout(ownerId, clientId, { lock }) : null;
	if (!workout || workout.deletedAt) throw new TrainingNotFoundError('workout');
	return workout;
}

/** Each field's exercise is in the owner's library (retired rows included), or a field error. */
async function checkExercises(db: Executor, ownerId: string, fields: Record<string, string>) {
	const found = await getExercisesByIds(ownerId, Object.values(fields), { db });
	const missing = Object.keys(fields).filter((field) => !found.has(fields[field]!));
	if (missing.length > 0) {
		throw new TrainingInputError(
			Object.fromEntries(missing.map((f) => [f, 'Not in your library']))
		);
	}
}

/**
 * Start a workout, ad hoc or from a planned session. A planned one names the session's row in
 * the version it was started from (getPlannedSession's id, the start kit's plannedSessionId), and
 * takes its lineage and program from that row, so 'completed' follows the lineage into every
 * later version. Starting from a lineage alone (Today's card) reads getPlannedSession first.
 */
export async function startWorkout(
	ownerId: string,
	input: unknown,
	deps: TrainingDeps = {}
): Promise<Created & { workout: WorkoutRow }> {
	const start = parseWith(startWorkoutSchema, input);
	const { db } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createTrainingLogRepository(tx);
			const link = start.plannedSessionId
				? await repo.plannedSessionLink(ownerId, start.plannedSessionId)
				: { plannedLineageId: null, programId: null };
			if (!link) throw new TrainingNotFoundError('planned session');
			const values = { ...start, ...link, ownerId };
			const { row, ...created } = answer(await repo.insertWorkout(values), values, 'clientId');
			return { workout: row, ...created };
		})
	);
}

/** Log one set in a workout, storing its e1RM. */
export async function logSet(
	ownerId: string,
	input: unknown,
	deps: TrainingDeps = {}
): Promise<Created & { set: SetRow }> {
	const { workoutClientId, ...set } = parseWith(logSetSchema, input);
	const { db } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createTrainingLogRepository(tx);
			const workout = await liveWorkout(repo, ownerId, workoutClientId);
			await checkExercises(tx, ownerId, { exerciseId: set.exerciseId });
			const values = { ...set, ownerId, workoutId: workout.id, e1rmKg: e1rmOf(set) };
			const { row, ...created } = answer(await repo.insertSet(values), values, 'clientMutationId');
			return { set: row, ...created };
		})
	);
}

/** Replace a set's values with `input`'s (all of them), storing its e1RM again. */
export async function editSet(
	ownerId: string,
	clientMutationId: string,
	input: unknown,
	deps: TrainingDeps = {}
): Promise<{ set: SetRow; changed: boolean }> {
	const edit = parseWith(editSetSchema, input);
	const { db, source } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createTrainingLogRepository(tx);
			const stored = isUuid(clientMutationId)
				? await repo.set(ownerId, clientMutationId, { lock: true })
				: null;
			if (!stored) throw new TrainingNotFoundError('set');
			if (stored.deletedAt) throw new TrainingLogConflictError();
			const values = { ...edit, e1rmKg: e1rmOf(edit) };
			if (holds(stored, values)) return { set: stored, changed: false };
			return { set: await repo.updateSet(stored.id, values, source), changed: true };
		})
	);
}

/** Delete a set softly; it stays, as a tombstone a replayed create cannot undo. */
export async function deleteSet(
	ownerId: string,
	clientMutationId: string,
	deps: TrainingDeps = {}
): Promise<{ set: SetRow; changed: boolean }> {
	const { db, now, source } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createTrainingLogRepository(tx);
			const stored = isUuid(clientMutationId)
				? await repo.set(ownerId, clientMutationId, { lock: true })
				: null;
			if (!stored) throw new TrainingNotFoundError('set');
			if (stored.deletedAt) return { set: stored, changed: false };
			return { set: await repo.softDeleteSet(stored.id, now(), source), changed: true };
		})
	);
}

/** Finish or abandon a workout, setting the summary fields `input` carries. */
export async function finishWorkout(
	ownerId: string,
	clientId: string,
	input: unknown,
	deps: TrainingDeps = {}
): Promise<{ workout: WorkoutRow; changed: boolean }> {
	const finish = parseWith(finishWorkoutSchema, input);
	const { db, source } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createTrainingLogRepository(tx);
			const workout = await liveWorkout(repo, ownerId, clientId, true);
			if (finish.finishedAt < workout.startedAt) {
				throw new TrainingInputError({ finishedAt: 'Not before the workout started' });
			}
			const values: WorkoutEdit = given(finish);
			if (holds(workout, values)) return { workout, changed: false };
			return { workout: await repo.updateWorkout(workout.id, values, source), changed: true };
		})
	);
}

/** Record an exercise swapped in a workout. It writes workout_substitutions only. */
export async function recordSubstitution(
	ownerId: string,
	input: unknown,
	deps: TrainingDeps = {}
): Promise<Created & { substitution: SubstitutionRow }> {
	const { workoutClientId, ...swap } = parseWith(substitutionSchema, input);
	const { db } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createTrainingLogRepository(tx);
			const workout = await liveWorkout(repo, ownerId, workoutClientId);
			const { fromExerciseId, toExerciseId } = swap;
			await checkExercises(tx, ownerId, { fromExerciseId, toExerciseId });
			const values = { ...swap, ownerId, workoutId: workout.id };
			const stored = await repo.insertSubstitution(values);
			const { row, ...created } = answer(stored, values, 'clientMutationId');
			return { substitution: row, ...created };
		})
	);
}

/** A workout and every set in it, in order, deleted ones included (as tombstones). */
export async function getWorkout(
	ownerId: string,
	clientId: string,
	deps: TrainingDeps = {}
): Promise<{ workout: WorkoutRow; sets: SetRow[] }> {
	const { db } = resolveDeps(deps);
	const found = isUuid(clientId)
		? await measure('db', () => createTrainingLogRepository(db).workoutWithSets(ownerId, clientId))
		: null;
	if (!found) throw new TrainingNotFoundError('workout');
	return found;
}
