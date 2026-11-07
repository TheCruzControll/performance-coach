/**
 * Logging training (PRD §7, §9): starting and finishing a workout, logging, editing and deleting
 * its sets, recording an in-workout substitution, logging and editing a run with its segments, an
 * other session (Muay Thai, mobility, S&C, custom) with its metrics, and a recovery note. Body
 * weight is not logged here: it stays M2's saveBody. M4's workout screens and the sync endpoint
 * that replays its offline outbox write through here, and so do the coach's tools (M5). Callers
 * import this module by path.
 *
 * The replay contract M4's outbox relies on (frozen here; m3/48 documents it):
 * - Rows are addressed by their device ids, as wire format v1 names them (the offline workout
 *   sync ADR): a workout by its client id, a set, a substitution, a run segment and a recovery
 *   note by their client mutation ids, and a workout's run or other session by the workout's
 *   client id. A device can name a row before its create has synced.
 * - Creates (startWorkout, logSet, recordSubstitution, logRun, addRunSegment, logOtherSession,
 *   recordRecoveryNote) are idempotent on that id. The first call writes the row; a replay writes
 *   nothing and returns the stored row with duplicate: true. The stored row always wins: matches
 *   says whether the replay carried the same values, so M4 can tell the owner when it did not. A
 *   replayed create of a deleted set returns its tombstone. A run is created with its segments:
 *   a replay matches only when the run and every segment do, and adds no segment. M4 logs a run by
 *   piece instead: logRun with any of its own values and no segments, and each segment through
 *   addRunSegment, which creates the run's record, its totals empty, when there is none yet.
 * - Edits (editSet, finishWorkout, editRun, editRunSegment, editOtherSession, editRecoveryNote)
 *   carry absolute values, never
 *   differences, so they are idempotent by value: one that changes nothing is skipped
 *   (changed: false), with no updated_at bump and no audit row. M4 applies one row's mutations
 *   in order, so an edit needs no id of its own. Editing a deleted set is refused
 *   (TrainingLogConflictError 'deleted').
 * - Deletes are soft (deleted_at). Deleting a deleted set returns it unchanged and writes nothing.
 * - A set records what its exercise is measured and loaded in, as logging-rules' checkSet says
 *   (a performed set; a skipped one records nothing): reps, seconds or metres, and a weight, an
 *   added weight or an assistance by the load type. Its refusals are field errors at the input's
 *   own paths ('weight'), as every error here is; the sync endpoint puts them under 'payload.'.
 * - Each set stores its e1RM in kg when logged: logging-rules' e1rmOf, M3's setE1rm where the
 *   load type estimates one (LOAD_RULES: an external-load reps set only). An edit that changes
 *   the weight, unit, reps, RPE or the warm-up or skipped flag stores it again, so the PR and
 *   history reads never see a stale one.
 * - Distances arrive in the unit entered and are stored in metres through M1's toMetres, so 5 mi
 *   is 8046.72 m; an edit in another unit that comes to the same metres changes nothing. Each
 *   pace is a generated column.
 * - Every write runs in the caller's transaction when deps.db is one: its own db.transaction is
 *   then a savepoint, which takes no connection of its own, so a sync handler's ledger row and
 *   the write commit or roll back together. Given the pool, each call is its own transaction. An
 *   edit sets app.actor to deps.source for the audit trigger, inside that transaction.
 * - startWorkout takes the planned session pinned to its row; a lineage or program the device
 *   names beside it must be that row's.
 * - A substitution stays on the workout: it never writes an exercise preference, whatever its
 *   reason (only an explicit 'never prescribe this again' does, m3/39).
 */
import { isDeepStrictEqual } from 'node:util';
import {
	editOtherSessionSchema,
	editRecoveryNoteSchema,
	editRunSchema,
	editRunSegmentSchema,
	editSetSchema,
	finishWorkoutSchema,
	logOtherSessionSchema,
	logRunSchema,
	logSetSchema,
	recoveryNoteSchema,
	runSegmentLogSchema,
	startWorkoutSchema,
	substitutionSchema
} from '../../../domain/training/schemas';
import { checkSet, e1rmOf, type RuledSet } from '../../../domain/workout/logging';
import { cleanFloat, toMetres, type DistanceUnit } from '../../../domain/units';
import {
	createTrainingLogRepository,
	type NewRunSegment,
	type OtherSessionRow,
	type RecoveryNoteRow,
	type OtherSessionEdit,
	type RunEdit,
	type RunRow,
	type RunSegmentEdit,
	type RunSegmentRow,
	type SetRow,
	type Stored,
	type SubstitutionRow,
	type WorkoutEdit,
	type WorkoutRow
} from '../../db/repositories/training-log';
import type { WorkoutKind } from '../../db/schema';
import type { Executor } from '../../db/types';
import { measure } from '../../observability/timing';
import { getExercisesByIds, type ExerciseDef } from '../exercises/index';
import { isUuid } from '../ids';
import {
	ConflictError,
	parseWith,
	resolveDeps,
	TrainingInputError,
	TrainingNotFoundError,
	type TrainingDeps
} from './shared';

export type {
	OtherSessionRow,
	RecoveryNoteRow,
	RunRow,
	RunSegmentRow,
	SetRow,
	SubstitutionRow,
	WorkoutRow
} from '../../db/repositories/training-log';

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

/** Whether `row` already holds every value in `values`: instants by time, jsonb by content. */
function holds<Row extends object>(row: Row, values: Partial<Row>): boolean {
	return Object.entries(values).every(([key, value]) => {
		const held: unknown = row[key as keyof Row];
		return typeof value === 'object' && value !== null
			? isDeepStrictEqual(value, held)
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

/** The e1RM a set stores, in kg: none where its exercise's load type estimates none. */
const storedE1rm = (set: RuledSet, exercise: ExerciseDef) => e1rmOf(set, exercise)?.value ?? null;

/**
 * Refuse a performed set its exercise cannot record, in checkSet's words at the input's paths
 * (checkSet names them under 'payload.', the mutation's). A skipped set records nothing.
 */
function checkMeasure(set: RuledSet, exercise: ExerciseDef) {
	if (set.isSkipped) return;
	const errors = Object.entries(checkSet(set, exercise));
	if (errors.length === 0) return;
	throw new TrainingInputError(
		Object.fromEntries(errors.map(([path, message]) => [path.replace(/^payload\./, ''), message]))
	);
}

/** What a start may name beside its planned session, and the refusal when it is not that row's. */
const PINNED = {
	plannedLineageId: 'Not this session’s lineage',
	programId: 'Not the program this session is in'
} as const;

/** The lineage and program a start names, when it names them, are its planned session's. */
function checkPin(
	start: Partial<Record<keyof typeof PINNED, string | null>>,
	link: Record<keyof typeof PINNED, string | null>
) {
	const fields = (Object.keys(PINNED) as (keyof typeof PINNED)[]).filter(
		(field) => start[field] !== undefined && start[field] !== link[field]
	);
	if (fields.length > 0) {
		throw new TrainingInputError(Object.fromEntries(fields.map((f) => [f, PINNED[f]])));
	}
}

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
	return found;
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
			checkPin(start, link);
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
			const found = await checkExercises(tx, ownerId, { exerciseId: set.exerciseId });
			const exercise = found.get(set.exerciseId)!;
			checkMeasure(set, exercise);
			const values = { ...set, ownerId, workoutId: workout.id, e1rmKg: storedE1rm(set, exercise) };
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
			const found = await getExercisesByIds(ownerId, [stored.exerciseId], { db: tx });
			const exercise = found.get(stored.exerciseId)!;
			checkMeasure(edit, exercise);
			const values = { ...edit, e1rmKg: storedE1rm(edit, exercise) };
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

// ---- runs, other sessions and recovery notes ------------------------------------------------

interface RunValues {
	distance: { value: number; unit: DistanceUnit } | null;
	durationSeconds: number | null;
	avgHr: number | null;
	rpe: number | null;
}

/** A run's or a segment's values as stored: the distance in metres, binary noise removed. */
const storedRunValues = ({ distance, durationSeconds, avgHr, rpe }: RunValues) => ({
	distanceMetres: distance && cleanFloat(toMetres(distance.value, distance.unit)),
	durationSeconds,
	avgHr,
	rpe
});

const NOT_KIND: Readonly<Record<Exclude<WorkoutKind, 'strength'>, string>> = {
	run: 'Not a run',
	other: 'Not a Muay Thai, mobility or other session'
};

/** The owner's live workout by its client id, which must be of `kind` to take its record. */
async function workoutOf(
	repo: Repo,
	ownerId: string,
	clientId: string,
	kind: keyof typeof NOT_KIND
) {
	const workout = await liveWorkout(repo, ownerId, clientId);
	if (workout.kind !== kind) throw new TrainingInputError({ workoutClientId: NOT_KIND[kind] });
	return workout;
}

/** Write a new run's segments, or a field error for any whose device id is already stored. */
async function addSegments(repo: Repo, segments: NewRunSegment[]) {
	const written = await repo.insertRunSegments(segments);
	const ids = new Set(written.map((s) => s.clientMutationId));
	const used = segments.flatMap((s, i) =>
		ids.has(s.clientMutationId) ? [] : [[`segments.${i}.clientMutationId`, 'Already used']]
	);
	if (used.length > 0) throw new TrainingInputError(Object.fromEntries(used));
	return written.sort((a, b) => a.position - b.position);
}

/**
 * Log a run in its run workout: its totals and its segments, each under the device's id. A
 * replay returns the stored run and segments; it matches only when the run and every segment do.
 */
export async function logRun(
	ownerId: string,
	input: unknown,
	deps: TrainingDeps = {}
): Promise<Created & { run: RunRow; segments: RunSegmentRow[] }> {
	const { workoutClientId, segments, notes, ...totals } = parseWith(logRunSchema, input);
	const { db } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createTrainingLogRepository(tx);
			const { id: workoutId } = await workoutOf(repo, ownerId, workoutClientId, 'run');
			const values = { ...storedRunValues(totals), notes, ownerId, workoutId };
			const pieces = segments.map(({ clientMutationId, position, kind, ...measured }) => ({
				...storedRunValues(measured),
				clientMutationId,
				position,
				kind,
				ownerId,
				workoutId
			}));
			const stored = await repo.insertRun(values);
			const held = stored.created
				? await addSegments(repo, pieces)
				: await repo.runSegments(workoutId);
			const ordered = [...pieces].sort((a, b) => a.position - b.position);
			const matches =
				holds(stored.row, values) &&
				held.length === ordered.length &&
				held.every((segment, i) => holds(segment, ordered[i]!));
			return { run: stored.row, segments: held, duplicate: !stored.created, matches };
		})
	);
}

/** Replace a run's own values (not its segments) with `input`'s, all of them. */
export async function editRun(
	ownerId: string,
	workoutClientId: string,
	input: unknown,
	deps: TrainingDeps = {}
): Promise<{ run: RunRow; changed: boolean }> {
	const { notes, ...edit } = parseWith(editRunSchema, input);
	const { db, source } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createTrainingLogRepository(tx);
			const workout = await liveWorkout(repo, ownerId, workoutClientId);
			const run = await repo.run(workout.id, { lock: true });
			if (!run) throw new TrainingNotFoundError('run');
			const values: RunEdit = { ...storedRunValues(edit), notes };
			if (holds(run, values)) return { run, changed: false };
			return { run: await repo.updateRun(workout.id, values, source), changed: true };
		})
	);
}

/**
 * Add one segment to a run workout's run, under the device's id, creating the run's record (its
 * totals empty) when there is none yet. A replay returns the stored segment.
 */
export async function addRunSegment(
	ownerId: string,
	workoutClientId: string,
	input: unknown,
	deps: TrainingDeps = {}
): Promise<Created & { segment: RunSegmentRow }> {
	const { clientMutationId, position, kind, ...measured } = parseWith(runSegmentLogSchema, input);
	const { db } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createTrainingLogRepository(tx);
			const { id: workoutId } = await workoutOf(repo, ownerId, workoutClientId, 'run');
			await repo.ensureRun(ownerId, workoutId);
			const values = { ...storedRunValues(measured), clientMutationId, position, kind };
			const row = { ...values, ownerId, workoutId };
			const [written] = await repo.insertRunSegments([row]);
			if (written) return { segment: written, duplicate: false, matches: true };
			const stored = await repo.runSegment(ownerId, clientMutationId);
			if (!stored || stored.workoutId !== workoutId) {
				throw new TrainingInputError({ clientMutationId: 'Already used' });
			}
			return { segment: stored, duplicate: true, matches: holds(stored, values) };
		})
	);
}

/** Replace a run segment's values with `input`'s, all of them. */
export async function editRunSegment(
	ownerId: string,
	clientMutationId: string,
	input: unknown,
	deps: TrainingDeps = {}
): Promise<{ segment: RunSegmentRow; changed: boolean }> {
	const { position, kind, ...measured } = parseWith(editRunSegmentSchema, input);
	const { db, source } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createTrainingLogRepository(tx);
			const stored = isUuid(clientMutationId)
				? await repo.runSegment(ownerId, clientMutationId, { lock: true })
				: null;
			if (!stored) throw new TrainingNotFoundError('run segment');
			const values: RunSegmentEdit = { ...storedRunValues(measured), position, kind };
			if (holds(stored, values)) return { segment: stored, changed: false };
			return { segment: await repo.updateRunSegment(stored.id, values, source), changed: true };
		})
	);
}

/** Log an other session (Muay Thai, mobility, S&C, custom) in its workout, with its metrics. */
export async function logOtherSession(
	ownerId: string,
	input: unknown,
	deps: TrainingDeps = {}
): Promise<Created & { session: OtherSessionRow }> {
	const { workoutClientId, ...session } = parseWith(logOtherSessionSchema, input);
	const { db } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createTrainingLogRepository(tx);
			const workout = await workoutOf(repo, ownerId, workoutClientId, 'other');
			const values = { ...session, ownerId, workoutId: workout.id };
			const stored = await repo.insertOtherSession(values);
			const { row, ...created } = answer(stored, values, 'workoutClientId');
			return { session: row, ...created };
		})
	);
}

/** Replace an other session's values with `input`'s, all of them. */
export async function editOtherSession(
	ownerId: string,
	workoutClientId: string,
	input: unknown,
	deps: TrainingDeps = {}
): Promise<{ session: OtherSessionRow; changed: boolean }> {
	const edit: OtherSessionEdit = parseWith(editOtherSessionSchema, input);
	const { db, source } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createTrainingLogRepository(tx);
			const workout = await liveWorkout(repo, ownerId, workoutClientId);
			const stored = await repo.otherSession(workout.id, { lock: true });
			if (!stored) throw new TrainingNotFoundError('other session');
			if (holds(stored, edit)) return { session: stored, changed: false };
			return { session: await repo.updateOtherSession(workout.id, edit, source), changed: true };
		})
	);
}

/** Record how the owner felt on a day: sleep, soreness, energy, stress or a note. */
export async function recordRecoveryNote(
	ownerId: string,
	input: unknown,
	deps: TrainingDeps = {}
): Promise<Created & { note: RecoveryNoteRow }> {
	const note = parseWith(recoveryNoteSchema, input);
	const { db } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createTrainingLogRepository(tx);
			const values = { ...note, ownerId };
			const stored = await repo.insertRecoveryNote(values);
			const { row, ...created } = answer(stored, values, 'clientMutationId');
			return { note: row, ...created };
		})
	);
}

/** Replace a recovery note's values with `input`'s, all of them. */
export async function editRecoveryNote(
	ownerId: string,
	clientMutationId: string,
	input: unknown,
	deps: TrainingDeps = {}
): Promise<{ note: RecoveryNoteRow; changed: boolean }> {
	const edit = parseWith(editRecoveryNoteSchema, input);
	const { db, source } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createTrainingLogRepository(tx);
			const stored = isUuid(clientMutationId)
				? await repo.recoveryNote(ownerId, clientMutationId, { lock: true })
				: null;
			if (!stored) throw new TrainingNotFoundError('recovery note');
			if (holds(stored, edit)) return { note: stored, changed: false };
			return { note: await repo.updateRecoveryNote(stored.id, edit, source), changed: true };
		})
	);
}
