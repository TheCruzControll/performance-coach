/**
 * What M4's logger records, stored on real Postgres (the M4 plan's log-gaps-db: M3 amendments
 * A1–A2 that m3/19 merged without).
 * - A set is measured in reps, seconds or metres, and one that is not skipped records at least
 *   one of them; seconds run 1 to a day, and missed reps 0 to 50 beside the reps done.
 * - An assisted set keeps its assistance in a column of its own, never beside a weight, so no
 *   weight-based read (weight_kg, volume, rep maxes, e1RM) can take assistance for load.
 * - A run's record exists from its first segment, before its totals; its pace waits for both.
 * - A substitution names its slot (the exercise's place in the workout) and can be deleted
 *   softly; a workout's substitutions are read by an index on the workout.
 * - M3's audit trigger covers the new columns like every other.
 * log-schema.test.ts holds the exhaustive table of every CHECK; this file walks the logger's sets.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
	exercises,
	getDb,
	runRecords,
	setRecords,
	trainingAudit,
	workouts,
	workoutSubstitutions,
	type Executor
} from '../../../src/lib/server/db';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const at = (time: string) => new Date(`2026-11-10T${time}:00Z`);
const deviceId = () => crypto.randomUUID();

type NewSet = typeof setRecords.$inferInsert;
type NewSubstitution = typeof workoutSubstitutions.$inferInsert;
type PgError = { code?: string; table?: string; constraint?: string };
const UNDO = Symbol('undo');

/** Run `write` in a savepoint that is always undone: the Postgres error, or null if accepted. */
async function attempt(db: Executor, write: (tx: Executor) => Promise<unknown>) {
	try {
		await db.transaction(async (tx) => {
			await write(tx);
			throw UNDO;
		});
	} catch (err) {
		if (err === UNDO) return null;
		const { code, table, constraint } = ((err as { cause?: PgError }).cause ?? err) as PgError;
		return { code, table, constraint };
	}
	throw new Error('unreachable');
}

/** An owner's strength workout and run, and the catalogue's exercises by key. */
async function setup(db: Executor) {
	const ownerId = await makeOwner(db);
	const keys = ['back_squat', 'plank', 'sled_push', 'pull_up', 'assisted_pull_up'];
	const library = await db
		.select({ id: exercises.id, key: exercises.key })
		.from(exercises)
		.where(inArray(exercises.key, keys));
	const exercise = Object.fromEntries(library.map((row) => [row.key, row.id]));
	expect(Object.keys(exercise).sort()).toEqual([...keys].sort());

	const workout = async (values: Pick<typeof workouts.$inferInsert, 'kind' | 'title'>) => {
		const [row] = await db
			.insert(workouts)
			.values({
				ownerId,
				clientId: deviceId(),
				discipline: values.kind === 'run' ? 'running' : 'strength',
				sessionType: values.kind === 'run' ? 'easy_run' : 'strength',
				startedAt: at('17:00'),
				...values
			})
			.returning();
		return row!.id;
	};
	const strength = await workout({ kind: 'strength', title: 'Full body A' });
	const run = await workout({ kind: 'run', title: 'Easy run' });

	let position = 0;
	/** A completed working set, with only what `values` records. */
	const set = (exerciseId: string, values: Partial<NewSet>): NewSet => ({
		ownerId,
		clientMutationId: deviceId(),
		workoutId: strength,
		exerciseId,
		exercisePosition: ++position,
		setIndex: 1,
		unit: 'kg',
		performedAt: at('17:10'),
		...values
	});
	const swap = (values: Partial<NewSubstitution> = {}): NewSubstitution => ({
		ownerId,
		clientMutationId: deviceId(),
		workoutId: strength,
		plannedExerciseLineageId: deviceId(),
		exercisePosition: 2,
		fromExerciseId: exercise.pull_up!,
		toExerciseId: exercise.assisted_pull_up!,
		reason: 'equipment_unavailable',
		...values
	});
	return { ownerId, exercise, strength, run, set, swap };
}

const insertSet = async (db: Executor, values: NewSet) => {
	const [row] = await db.insert(setRecords).values(values).returning();
	return row!;
};

/** A row's audit trail, oldest first. */
const auditOf = (db: Executor, table: string, rowId: string | number) =>
	db
		.select()
		.from(trainingAudit)
		.where(and(eq(trainingAudit.tableName, table), eq(trainingAudit.rowId, String(rowId))))
		.orderBy(asc(trainingAudit.id));

describe('set records for every measure and load type', () => {
	it('store time, distance, assisted, skipped and missed-rep sets as the logger records them', async () => {
		await withRollback(async (db) => {
			const { exercise, set } = await setup(db);

			const plank = await insertSet(db, set(exercise.plank!, { seconds: 45 }));
			const sled = await insertSet(db, set(exercise.sled_push!, { metres: 30, weight: 60 }));
			const assisted = await insertSet(
				db,
				set(exercise.assisted_pull_up!, { reps: 6, assistance: 20 })
			);
			const skipped = await insertSet(db, set(exercise.back_squat!, { isSkipped: true }));
			const oneOfFive = await insertSet(
				db,
				set(exercise.back_squat!, { weight: 140, reps: 1, missedReps: 4 })
			);

			expect(plank).toMatchObject({ seconds: 45, reps: null, metres: null, weight: null });
			expect(sled).toMatchObject({ metres: 30, weight: 60, weightKg: 60, reps: null });
			// Assistance is never load: weight_kg, which every weight-based read uses, stays null.
			expect(assisted).toMatchObject({ reps: 6, assistance: 20, weight: null, weightKg: null });
			expect(skipped).toMatchObject({ isSkipped: true, weight: null, reps: null, seconds: null });
			expect(oneOfFive).toMatchObject({ reps: 1, missedReps: 4, weightKg: 140 });
			expect(sled.assistance).toBeNull();
		});
	});

	it('refuse a set that records nothing, a weight beside an assistance, and amounts out of range', async () => {
		await withRollback(async (db) => {
			const { exercise, set } = await setup(db);
			const cases: [string, NewSet, string][] = [
				[
					'a set that is not skipped with no reps, seconds or distance',
					set(exercise.back_squat!, { weight: 100 }),
					'set_records_measure_ck'
				],
				[
					'a weight together with an assistance',
					set(exercise.assisted_pull_up!, { reps: 6, weight: 10, assistance: 20 }),
					'set_records_load_ck'
				],
				[
					'0 kg of assistance',
					set(exercise.assisted_pull_up!, { reps: 6, assistance: 0 }),
					'set_records_assistance_ck'
				],
				['a 0 s hold', set(exercise.plank!, { seconds: 0 }), 'set_records_seconds_ck'],
				['a hold over a day', set(exercise.plank!, { seconds: 86_401 }), 'set_records_seconds_ck'],
				[
					'a 0 m push',
					set(exercise.sled_push!, { metres: 0, weight: 60 }),
					'set_records_metres_ck'
				],
				[
					'51 missed reps',
					set(exercise.back_squat!, { weight: 100, reps: 0, missedReps: 51 }),
					'set_records_missed_reps_ck'
				]
			];
			for (const [what, row, constraint] of cases) {
				expect(await attempt(db, (tx) => tx.insert(setRecords).values(row)), what).toEqual({
					code: '23514',
					table: 'set_records',
					constraint
				});
			}

			// The edges are accepted: a day-long hold and 50 missed reps.
			const edges = [
				set(exercise.plank!, { seconds: 86_400 }),
				set(exercise.back_squat!, { weight: 100, reps: 0, missedReps: 50 })
			];
			for (const row of edges) {
				expect(await attempt(db, (tx) => tx.insert(setRecords).values(row))).toBeNull();
			}
		});
	});
});

describe('run records before their totals', () => {
	it('store a run from its first segment with no totals, its pace only once both are set', async () => {
		await withRollback(async (db) => {
			const { ownerId, run } = await setup(db);
			const read = async () => {
				const [row] = await db.select().from(runRecords).where(eq(runRecords.workoutId, run));
				return row!;
			};

			await db.insert(runRecords).values({ ownerId, workoutId: run });
			expect(await read()).toMatchObject({
				distanceMetres: null,
				durationSeconds: null,
				paceSecondsPerKm: null
			});
			await db
				.update(runRecords)
				.set({ distanceMetres: 5000 })
				.where(eq(runRecords.workoutId, run));
			expect((await read()).paceSecondsPerKm).toBeNull();
			await db
				.update(runRecords)
				.set({ durationSeconds: 1500 })
				.where(eq(runRecords.workoutId, run));
			expect((await read()).paceSecondsPerKm).toBe(300);

			const zero = (tx: Executor) =>
				tx.update(runRecords).set({ distanceMetres: 0 }).where(eq(runRecords.workoutId, run));
			expect(await attempt(db, zero)).toEqual({
				code: '23514',
				table: 'run_records',
				constraint: 'run_records_distance_ck'
			});
		});
	});
});

describe('substitutions in their slot', () => {
	it('round-trip with the slot; an unknown exercise or slot 0 is refused', async () => {
		await withRollback(async (db) => {
			const { swap } = await setup(db);
			const values = swap();

			const [stored] = await db.insert(workoutSubstitutions).values(values).returning();
			const [read] = await db
				.select()
				.from(workoutSubstitutions)
				.where(eq(workoutSubstitutions.workoutId, values.workoutId));
			expect(read).toEqual(stored);
			expect(read).toMatchObject({ ...values, exercisePosition: 2, deletedAt: null });

			const unknown = swap({ toExerciseId: deviceId() });
			expect(await attempt(db, (tx) => tx.insert(workoutSubstitutions).values(unknown))).toEqual({
				code: '23503',
				table: 'workout_substitutions',
				constraint: 'workout_substitutions_to_exercise_id_exercises_id_fk'
			});
			const slotZero = swap({ exercisePosition: 0 });
			expect(await attempt(db, (tx) => tx.insert(workoutSubstitutions).values(slotZero))).toEqual({
				code: '23514',
				table: 'workout_substitutions',
				constraint: 'workout_substitutions_exercise_position_ck'
			});
		});
	});

	it('are read by their workout through an index', async () => {
		const { rows } = await getDb().execute<{ definition: string }>(
			sql`select indexdef as definition from pg_indexes
				where indexname = 'workout_substitutions_workout_idx'`
		);
		expect(rows).toEqual([
			{
				definition:
					'CREATE INDEX workout_substitutions_workout_idx ON public.workout_substitutions USING btree (workout_id)'
			}
		]);
	});
});

describe('the new columns under the audit trigger', () => {
	it('audit an UPDATE of seconds, metres, assistance, the slot and a soft delete once each', async () => {
		await withRollback(async (db) => {
			const { exercise, set, swap } = await setup(db);
			const plank = await insertSet(db, set(exercise.plank!, { seconds: 45 }));
			const sled = await insertSet(db, set(exercise.sled_push!, { metres: 30, weight: 60 }));
			const assisted = await insertSet(
				db,
				set(exercise.assisted_pull_up!, { reps: 6, assistance: 20 })
			);
			const [substitution] = await db.insert(workoutSubstitutions).values(swap()).returning();
			const swapId = substitution!.id;

			const edit = async (id: number, values: Partial<NewSet>) => {
				await db.update(setRecords).set(values).where(eq(setRecords.id, id));
				await db.update(setRecords).set(values).where(eq(setRecords.id, id)); // the same again
			};
			await edit(plank.id, { seconds: 60 });
			await edit(sled.id, { metres: 40 });
			await edit(assisted.id, { assistance: 15 });
			const moveSwap = (values: Partial<NewSubstitution>) =>
				db.update(workoutSubstitutions).set(values).where(eq(workoutSubstitutions.id, swapId));
			await moveSwap({ exercisePosition: 3 });
			await moveSwap({ exercisePosition: 3 });
			await moveSwap({ deletedAt: at('17:30') });

			const trail = async (table: string, id: string | number) =>
				(await auditOf(db, table, id)).map((a) => ({
					action: a.action,
					before: a.before,
					after: a.after
				}));
			expect(await trail('set_records', plank.id)).toEqual([
				expect.objectContaining({
					action: 'update',
					before: expect.objectContaining({ seconds: 45 }),
					after: expect.objectContaining({ seconds: 60 })
				})
			]);
			expect(await trail('set_records', sled.id)).toEqual([
				expect.objectContaining({
					before: expect.objectContaining({ metres: 30 }),
					after: expect.objectContaining({ metres: 40 })
				})
			]);
			expect(await trail('set_records', assisted.id)).toEqual([
				expect.objectContaining({
					before: expect.objectContaining({ assistance: 20, weight: null }),
					after: expect.objectContaining({ assistance: 15, weight: null })
				})
			]);
			expect(await trail('workout_substitutions', swapId)).toEqual([
				expect.objectContaining({
					action: 'update',
					before: expect.objectContaining({ exercise_position: 2 }),
					after: expect.objectContaining({ exercise_position: 3 })
				}),
				expect.objectContaining({
					action: 'delete',
					before: expect.objectContaining({ deleted_at: null }),
					after: expect.objectContaining({ exercise_position: 3 })
				})
			]);
		});
	});
});
