/**
 * What the sync endpoint (services/workouts/sync.ts) reads and writes beside M3's training-log
 * repository: who owns a workout or a set a device names, a workout's canonical rows, and the
 * one workout write M3 lacks (workout.update: notes, session RPE and duration while it runs).
 * Plain data access: what a lookup means for a mutation is the service's to decide.
 *
 * - Lookups by client id use the unique indexes (workouts_client_id_uq,
 *   set_records_client_mutation_id_uq); a workout's rows use their workout_id indexes.
 * - The canonical reads keep tombstones (deleted_at), so a replayed create cannot undo a delete
 *   on a device that reconciles.
 * - An update sets app.actor inside its own transaction (a savepoint in the caller's), as M3's
 *   edits do, so the audit trigger records who changed the row.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Decider } from '../../../domain/training/vocabulary';
import {
	AUDIT_ACTOR_SETTING,
	otherSessionRecords,
	painReports,
	runRecords,
	runRecordSegments,
	setRecords,
	workouts,
	workoutSubstitutions
} from '../schema';
import type { Executor } from '../types';
import { createTrainingLogRepository, type WorkoutRow } from './training-log';

/** The fields workout.update sets on a workout; a field left out keeps its value. */
export type WorkoutFieldsEdit = Partial<
	Pick<typeof workouts.$inferInsert, 'notes' | 'sessionRpe' | 'durationSeconds'>
>;

export function createWorkoutSyncRepository(db: Executor) {
	return {
		/** The owner of the workout with this client id, whoever it is; null when none has it. */
		async workoutOwner(clientId: string): Promise<string | null> {
			const [row] = await db
				.select({ ownerId: workouts.ownerId })
				.from(workouts)
				.where(eq(workouts.clientId, clientId));
			return row?.ownerId ?? null;
		},

		/** The owner of the set with this client mutation id, whoever it is; null when none has it. */
		async setOwner(clientMutationId: string): Promise<string | null> {
			const [row] = await db
				.select({ ownerId: setRecords.ownerId })
				.from(setRecords)
				.where(eq(setRecords.clientMutationId, clientMutationId));
			return row?.ownerId ?? null;
		},

		/** The owner's live workout by client id, locked for the rest of the transaction. */
		async lockWorkout(ownerId: string, clientId: string): Promise<WorkoutRow | null> {
			const [row] = await db
				.select()
				.from(workouts)
				.where(and(eq(workouts.ownerId, ownerId), eq(workouts.clientId, clientId)))
				.for('update');
			return row && !row.deletedAt ? row : null;
		},

		/** Set a workout's notes, session RPE or duration, audited as `actor`. */
		async updateWorkoutFields(
			id: string,
			values: WorkoutFieldsEdit,
			actor: Decider
		): Promise<WorkoutRow> {
			return db.transaction(async (tx) => {
				await tx.execute(sql`select set_config(${AUDIT_ACTOR_SETTING}, ${actor}, true)`);
				const [row] = await tx.update(workouts).set(values).where(eq(workouts.id, id)).returning();
				return row!;
			});
		},

		/**
		 * Everything the owner's workout holds, deleted rows included, or null when the owner has
		 * no workout with this client id. One keyed lookup per table, awaited in turn.
		 */
		async canonicalRows(ownerId: string, clientId: string) {
			const found = await createTrainingLogRepository(db).workoutWithSets(ownerId, clientId);
			if (!found) return null;
			const workoutId = found.workout.id;
			const substitutions = await db
				.select()
				.from(workoutSubstitutions)
				.where(eq(workoutSubstitutions.workoutId, workoutId))
				.orderBy(asc(workoutSubstitutions.createdAt), asc(workoutSubstitutions.id));
			const pain = await db
				.select()
				.from(painReports)
				.where(eq(painReports.workoutId, workoutId))
				.orderBy(asc(painReports.reportedAt), asc(painReports.id));
			const [run] = await db.select().from(runRecords).where(eq(runRecords.workoutId, workoutId));
			const segments = run
				? await db
						.select()
						.from(runRecordSegments)
						.where(eq(runRecordSegments.workoutId, workoutId))
						.orderBy(asc(runRecordSegments.position))
				: [];
			const [other] = await db
				.select()
				.from(otherSessionRecords)
				.where(eq(otherSessionRecords.workoutId, workoutId));
			return {
				...found,
				substitutions,
				pain,
				run: run ?? null,
				segments,
				other: other ?? null
			};
		}
	};
}

export type WorkoutSyncRepository = ReturnType<typeof createWorkoutSyncRepository>;
export type CanonicalRows = NonNullable<
	Awaited<ReturnType<WorkoutSyncRepository['canonicalRows']>>
>;
