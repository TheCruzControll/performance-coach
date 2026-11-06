/**
 * Logging workouts and sets on real Postgres (src/lib/server/services/training/log.ts): the write
 * path M4's offline outbox replays against, and the replay contract it freezes.
 * - A create is idempotent on its device id: a replay writes nothing and returns the stored row
 *   with duplicate: true; matches says whether its payload was the same, and the stored row wins.
 * - Edits carry absolute values: a replayed edit changes nothing, bumps no updated_at and writes
 *   no audit row; a real one writes exactly one. Deletes are soft, and a replayed delete writes
 *   nothing.
 * - Each set stores its e1RM (the metrics' setE1rm), recomputed whenever an edit changes it.
 * - A situational substitution stays on the workout and never becomes a preference.
 * Audit assertions always filter by table and row id.
 */
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { bestE1rm, setE1rm } from '../../../src/lib/domain/training/metrics';
import {
	exercisePreferences,
	setRecords,
	trainingAudit,
	workouts,
	workoutSubstitutions,
	type Executor
} from '../../../src/lib/server/db';
import type { SetRow } from '../../../src/lib/server/db/repositories/training-log';
import { resolveKeys } from '../../../src/lib/server/services/exercises/index';
import {
	createProgramFromPlan,
	getProgramVersion,
	getTrainingWeek
} from '../../../src/lib/server/services/programs/index';
import {
	deleteSet,
	editSet,
	finishWorkout,
	getWorkout,
	logSet,
	recordSubstitution,
	startWorkout,
	TrainingLogConflictError
} from '../../../src/lib/server/services/training/log';
import {
	TrainingInputError,
	TrainingNotFoundError
} from '../../../src/lib/server/services/training/shared';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const MONDAY = '2026-11-09';
/** An instant on Tuesday 10 November 2026, in UTC, as a device sends it. */
const at = (time: string) => `2026-11-10T${time}:00.000Z`;
const deviceId = () => crypto.randomUUID();

const startInput = (over: Record<string, unknown> = {}) => ({
	clientId: deviceId(),
	kind: 'strength',
	discipline: 'strength',
	sessionType: 'strength',
	title: 'Lower body',
	plannedSessionId: null,
	startedAt: at('07:00'),
	...over
});

/** A working set of 100 kg × 5 @ RPE 8, every value given. */
const setInput = (workout: string, exerciseId: string, over: Record<string, unknown> = {}) => ({
	clientMutationId: deviceId(),
	workoutClientId: workout,
	exerciseId,
	plannedExerciseLineageId: null,
	exercisePosition: 1,
	setIndex: 1,
	weight: 100,
	unit: 'kg',
	reps: 5,
	missedReps: 0,
	seconds: null,
	metres: null,
	rpe: 8,
	isWarmup: false,
	isExtra: false,
	isSkipped: false,
	performedAt: at('07:10'),
	...over
});

/** A set's values as editSet takes them: all of them, absolute. */
const valuesOf = (set: SetRow) => ({
	weight: set.weight,
	unit: set.unit,
	reps: set.reps,
	missedReps: set.missedReps,
	seconds: set.seconds,
	metres: set.metres,
	rpe: set.rpe,
	isWarmup: set.isWarmup,
	isExtra: set.isExtra,
	isSkipped: set.isSkipped
});

/** The owner, a started strength workout (by its client id) and three catalogue exercises. */
async function setup(db: Executor) {
	const owner = await makeOwner(db);
	const keys = await resolveKeys(['back_squat', 'front_squat', 'goblet_squat'], { db });
	const workout = deviceId();
	await startWorkout(owner, startInput({ clientId: workout }), { db });
	return {
		owner,
		workout,
		squat: keys.get('back_squat')!.id,
		frontSquat: keys.get('front_squat')!.id,
		gobletSquat: keys.get('goblet_squat')!.id
	};
}

const setsByClientId = (db: Executor, id: string) =>
	db.select().from(setRecords).where(eq(setRecords.clientMutationId, id));

const auditOf = (db: Executor, table: string, rowId: number | string) =>
	db
		.select()
		.from(trainingAudit)
		.where(and(eq(trainingAudit.tableName, table), eq(trainingAudit.rowId, String(rowId))))
		.orderBy(trainingAudit.id);

/**
 * The exercise's best e1RM as the PR read takes it (getPersonalRecords, m3/26, through
 * set_records_exercise_e1rm_idx): the highest stored e1rm_kg among live sets.
 */
async function bestStoredE1rm(db: Executor, owner: string, exerciseId: string) {
	const [best] = await db
		.select({ e1rmKg: setRecords.e1rmKg })
		.from(setRecords)
		.where(
			and(
				eq(setRecords.ownerId, owner),
				eq(setRecords.exerciseId, exerciseId),
				isNotNull(setRecords.e1rmKg),
				isNull(setRecords.deletedAt)
			)
		)
		.orderBy(desc(setRecords.e1rmKg))
		.limit(1);
	return best?.e1rmKg ?? null;
}

/** The error a call was refused with (fails the test if it was not refused). */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	if (!error) throw new Error('expected the call to be refused');
	return error;
}

async function fieldErrors(promise: Promise<unknown>) {
	const error = await refusal(promise);
	expect(error).toBeInstanceOf(TrainingInputError);
	return (error as TrainingInputError).errors;
}

describe('logSet: a create is idempotent on its client mutation id', () => {
	it('stores a replay once, returning the stored row as a matching duplicate', async () => {
		await withRollback(async (db) => {
			const { owner, workout, squat } = await setup(db);
			const input = setInput(workout, squat);

			const first = await logSet(owner, input, { db });
			const replay = await logSet(owner, input, { db });

			expect(first).toMatchObject({ duplicate: false, matches: true });
			expect(replay).toEqual({ set: first.set, duplicate: true, matches: true });
			expect(await setsByClientId(db, input.clientMutationId)).toHaveLength(1);
		});
	});

	it('keeps the stored row when a replay carries another weight, and says so', async () => {
		await withRollback(async (db) => {
			const { owner, workout, squat } = await setup(db);
			const input = setInput(workout, squat);
			const first = await logSet(owner, input, { db });

			const replay = await logSet(owner, { ...input, weight: 105 }, { db });

			expect(replay).toEqual({ set: first.set, duplicate: true, matches: false });
			const [stored] = await setsByClientId(db, input.clientMutationId);
			expect(stored).toEqual(first.set);
			expect(stored!.weight).toBe(100);
			expect(await auditOf(db, 'set_records', first.set.id)).toEqual([]);
		});
	});

	it('stores one row when two connections send the same set at once', async () => {
		await withCommitted(async (db) => {
			const { owner, workout, squat } = await setup(db);
			const input = setInput(workout, squat);

			// Each call runs its own transaction on its own pooled connection.
			const results = await Promise.all([logSet(owner, input), logSet(owner, input)]);

			expect(await setsByClientId(db, input.clientMutationId)).toHaveLength(1);
			expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
			expect(results.every((r) => r.matches)).toBe(true);
			expect(results[0]!.set).toEqual(results[1]!.set);
		});
	});

	it('refuses what it cannot store, and a workout it cannot find', async () => {
		await withRollback(async (db) => {
			const { owner, workout, squat } = await setup(db);
			const noReps = setInput(workout, squat, { reps: null, missedReps: 2 });
			expect(await fieldErrors(logSet(owner, noReps, { db }))).toEqual({
				reps: 'Record reps, a time or a distance',
				missedReps: 'Missed reps go with the reps done'
			});
			expect(await fieldErrors(logSet(owner, setInput(workout, deviceId()), { db }))).toEqual({
				exerciseId: 'Not in your library'
			});
			expect(await refusal(logSet(owner, setInput(deviceId(), squat), { db }))).toBeInstanceOf(
				TrainingNotFoundError
			);
			expect(await db.select().from(setRecords)).toEqual([]);
		});
	});
});

describe('startWorkout: a workout is stored once per client id', () => {
	it('returns the stored workout on a replay, and says when the payload differs', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const input = startInput();

			const first = await startWorkout(owner, input, { db });
			const replay = await startWorkout(owner, input, { db });
			const renamed = await startWorkout(owner, { ...input, title: 'Legs' }, { db });

			expect(first).toMatchObject({ duplicate: false, matches: true });
			expect(first.workout).toMatchObject({ title: 'Lower body', status: 'in_progress' });
			expect(replay).toEqual({ workout: first.workout, duplicate: true, matches: true });
			expect(renamed).toEqual({ workout: first.workout, duplicate: true, matches: false });
			const stored = await db.select().from(workouts).where(eq(workouts.clientId, input.clientId));
			expect(stored).toEqual([first.workout]);
		});
	});

	it('links a planned session by its row, and refuses one it cannot find', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const plan = programFixture('hybrid', { monday: MONDAY, today: MONDAY });
			const { programId } = await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
			const stored = await getProgramVersion(owner, programId, 1, { db });
			const session = stored.blocks[0]!.weeks[0]!.sessions.find((s) => s.kind === 'strength')!;

			const { workout } = await startWorkout(owner, startInput({ plannedSessionId: session.id }), {
				db
			});

			expect(workout).toMatchObject({
				plannedSessionId: session.id,
				plannedLineageId: session.lineage,
				programId
			});
			const unknown = startWorkout(owner, startInput({ plannedSessionId: deviceId() }), { db });
			expect(await refusal(unknown)).toBeInstanceOf(TrainingNotFoundError);
		});
	});
});

describe('what a logged set stores', () => {
	it('keeps an lb entry as entered, beside an exact weight in kg', async () => {
		await withRollback(async (db) => {
			const { owner, workout, squat } = await setup(db);

			const { set } = await logSet(owner, setInput(workout, squat, { weight: 225, unit: 'lb' }), {
				db
			});

			expect(set).toMatchObject({ weight: 225, unit: 'lb', weightKg: 102.05828325 });
		});
	});

	it('stores the e1RM of 5 @ RPE 8, and none for a warm-up', async () => {
		await withRollback(async (db) => {
			const { owner, workout, squat } = await setup(db);

			const working = await logSet(owner, setInput(workout, squat), { db });
			const warmUp = await logSet(
				owner,
				setInput(workout, squat, { setIndex: 2, weight: 60, isWarmup: true }),
				{ db }
			);

			const expected = setE1rm({
				weight: 100,
				unit: 'kg',
				reps: 5,
				rpe: 8,
				isWarmup: false,
				isSkipped: false
			})!.value;
			expect(working.set.e1rmKg).toBe(expected);
			expect(expected).toBeGreaterThan(120);
			expect(warmUp.set.e1rmKg).toBeNull();
		});
	});
});

describe('editSet: absolute values, with the e1RM kept current', () => {
	it('recomputes the e1RM when the reps change and clears it for a warm-up', async () => {
		await withRollback(async (db) => {
			const { owner, workout, squat } = await setup(db);
			const { set } = await logSet(owner, setInput(workout, squat), { db });
			const id = set.clientMutationId;
			const fiveAtEight = set.e1rmKg!;

			const triple = await editSet(owner, id, { ...valuesOf(set), reps: 3 }, { db });

			const threeAtEight = setE1rm({ ...valuesOf(set), reps: 3 })!.value;
			expect(triple).toMatchObject({ changed: true, set: { reps: 3, e1rmKg: threeAtEight } });
			expect(threeAtEight).toBeLessThan(fiveAtEight);
			expect(await bestStoredE1rm(db, owner, squat)).toBe(threeAtEight);
			const stored = await db.select().from(setRecords).where(eq(setRecords.exerciseId, squat));
			expect(bestE1rm(stored)!.value).toBe(threeAtEight);

			const warmUp = await editSet(owner, id, { ...valuesOf(triple.set), isWarmup: true }, { db });

			expect(warmUp.set).toMatchObject({ isWarmup: true, e1rmKg: null });
			expect(await bestStoredE1rm(db, owner, squat)).toBeNull();
		});
	});

	it('audits a real edit once; its replay writes nothing and keeps updated_at', async () => {
		await withRollback(async (db) => {
			const { owner, workout, squat } = await setup(db);
			const { set } = await logSet(owner, setInput(workout, squat), { db });
			const edit = { ...valuesOf(set), weight: 102.5 };

			const first = await editSet(owner, set.clientMutationId, edit, { db });
			const replay = await editSet(owner, set.clientMutationId, edit, { db });

			expect(first.changed).toBe(true);
			expect(first.set.updatedAt.getTime()).toBeGreaterThan(set.updatedAt.getTime());
			expect(replay).toEqual({ set: first.set, changed: false });
			const [stored] = await setsByClientId(db, set.clientMutationId);
			expect(stored!.updatedAt).toEqual(first.set.updatedAt);
			const audit = await auditOf(db, 'set_records', set.id);
			expect(audit).toHaveLength(1);
			expect(audit[0]).toMatchObject({
				action: 'update',
				actor: 'owner',
				ownerId: owner,
				before: { weight: 100 },
				after: { weight: 102.5 }
			});
		});
	});

	it('records who edited: the coach, through its tools', async () => {
		await withRollback(async (db) => {
			const { owner, workout, squat } = await setup(db);
			const { set } = await logSet(owner, setInput(workout, squat), { db });

			await editSet(
				owner,
				set.clientMutationId,
				{ ...valuesOf(set), rpe: 8.5 },
				{
					db,
					source: 'coach'
				}
			);

			expect(await auditOf(db, 'set_records', set.id)).toEqual([
				expect.objectContaining({ action: 'update', actor: 'coach' })
			]);
		});
	});

	it('takes every value, so a partial edit is refused and writes nothing', async () => {
		await withRollback(async (db) => {
			const { owner, workout, squat } = await setup(db);
			const { set } = await logSet(owner, setInput(workout, squat), { db });

			const errors = await fieldErrors(editSet(owner, set.clientMutationId, { reps: 3 }, { db }));

			expect(Object.keys(errors)).toContain('weight');
			expect(await setsByClientId(db, set.clientMutationId)).toEqual([set]);
		});
	});
});

describe('deleteSet: soft, and idempotent', () => {
	it('deletes softly with one audit row; a replayed delete writes nothing', async () => {
		await withRollback(async (db) => {
			const { owner, workout, squat } = await setup(db);
			const { set } = await logSet(owner, setInput(workout, squat), { db });

			const first = await deleteSet(owner, set.clientMutationId, { db });
			const replay = await deleteSet(owner, set.clientMutationId, { db });

			expect(first.changed).toBe(true);
			expect(first.set.deletedAt).toBeInstanceOf(Date);
			expect(replay).toEqual({ set: first.set, changed: false });
			expect(await setsByClientId(db, set.clientMutationId)).toEqual([first.set]);
			expect(await auditOf(db, 'set_records', set.id)).toEqual([
				expect.objectContaining({ action: 'delete', actor: 'owner' })
			]);
			expect(await bestStoredE1rm(db, owner, squat)).toBeNull();
		});
	});

	it('refuses to edit a deleted set, and a replayed create returns its tombstone', async () => {
		await withRollback(async (db) => {
			const { owner, workout, squat } = await setup(db);
			const input = setInput(workout, squat);
			const { set } = await logSet(owner, input, { db });
			const { set: tombstone } = await deleteSet(owner, set.clientMutationId, { db });

			const edit = editSet(owner, set.clientMutationId, { ...valuesOf(set), reps: 3 }, { db });

			const error = await refusal(edit);
			expect(error).toBeInstanceOf(TrainingLogConflictError);
			expect((error as TrainingLogConflictError).reason).toBe('deleted');
			expect(await logSet(owner, input, { db })).toEqual({
				set: tombstone,
				duplicate: true,
				matches: true
			});
			expect(await auditOf(db, 'set_records', set.id)).toHaveLength(1);
		});
	});
});

describe('recordSubstitution: on the workout only', () => {
	it('records a situational swap once and writes no exercise preference', async () => {
		await withRollback(async (db) => {
			const { owner, workout, squat, gobletSquat } = await setup(db);
			const input = {
				clientMutationId: deviceId(),
				workoutClientId: workout,
				plannedExerciseLineageId: deviceId(),
				fromExerciseId: squat,
				toExerciseId: gobletSquat,
				reason: 'situational'
			};

			const first = await recordSubstitution(owner, input, { db });
			const replay = await recordSubstitution(owner, input, { db });

			expect(first).toMatchObject({
				duplicate: false,
				matches: true,
				substitution: { fromExerciseId: squat, toExerciseId: gobletSquat, reason: 'situational' }
			});
			expect(replay).toEqual({ substitution: first.substitution, duplicate: true, matches: true });
			expect(await db.select().from(workoutSubstitutions)).toEqual([first.substitution]);
			expect(
				await db.select().from(exercisePreferences).where(eq(exercisePreferences.ownerId, owner))
			).toEqual([]);
			const same = { ...input, clientMutationId: deviceId(), toExerciseId: squat };
			expect(await fieldErrors(recordSubstitution(owner, same, { db }))).toEqual({
				toExerciseId: 'Pick a different exercise'
			});
		});
	});
});

describe('finishWorkout', () => {
	it('completes the planned session in getTrainingWeek', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const plan = programFixture('hybrid', { monday: MONDAY, today: MONDAY });
			const { programId } = await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
			const stored = await getProgramVersion(owner, programId, 1, { db });
			const session = stored.blocks[0]!.weeks[0]!.sessions.find((s) => s.kind === 'strength')!;
			const statusOf = async () => {
				const week = await getTrainingWeek(owner, { date: session.date }, {}, { db });
				const days = week?.planned ? week.days : [];
				return days.flatMap((d) => d.sessions).find((s) => s.lineage === session.lineage)!.status;
			};
			const startedAt = `${session.date}T07:00:00.000Z`;
			const clientId = deviceId();
			await startWorkout(owner, startInput({ clientId, plannedSessionId: session.id, startedAt }), {
				db
			});
			expect(await statusOf()).toBe('planned');

			const finished = await finishWorkout(
				owner,
				clientId,
				{ status: 'completed', finishedAt: `${session.date}T08:05:00.000Z`, sessionRpe: 7 },
				{ db }
			);

			expect(finished).toMatchObject({
				changed: true,
				workout: { status: 'completed', sessionRpe: 7 }
			});
			expect(await statusOf()).toBe('completed');
		});
	});

	it('changes nothing on a replay, and refuses a finish before the start', async () => {
		await withRollback(async (db) => {
			const { owner, workout } = await setup(db);
			const finish = { status: 'completed', finishedAt: at('08:00'), durationSeconds: 3300 };

			const first = await finishWorkout(owner, workout, finish, { db });
			const replay = await finishWorkout(owner, workout, finish, { db });

			expect(first).toMatchObject({ changed: true, workout: { durationSeconds: 3300 } });
			expect(replay).toEqual({ workout: first.workout, changed: false });
			expect(await auditOf(db, 'workouts', first.workout.id)).toHaveLength(1);
			const early = finishWorkout(owner, workout, { ...finish, finishedAt: at('06:00') }, { db });
			expect(await fieldErrors(early)).toEqual({ finishedAt: 'Not before the workout started' });
			const { workout: read, sets } = await getWorkout(owner, workout, { db });
			expect(read).toEqual(first.workout);
			expect(sets).toEqual([]);
		});
	});
});
