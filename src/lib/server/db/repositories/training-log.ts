/**
 * Training-log persistence (schema/training-log.ts): workouts, their sets and in-workout
 * substitutions. Plain data access: validation and the replay contract belong to
 * src/lib/server/services/training/log.ts.
 *
 * - A create inserts ON CONFLICT DO NOTHING on its device id, then returns the stored row, and
 *   whether this call wrote it. The stored row is read by owner, so a device id never returns
 *   another owner's row.
 * - An edit or a soft delete runs in its own transaction (a savepoint inside the caller's) that
 *   first sets app.actor, so the audit trigger records who changed the row.
 * - Rows are read by owner and device id, which their unique indexes cover.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Decider } from '../../../domain/training/vocabulary';
import {
	AUDIT_ACTOR_SETTING,
	plannedSessions,
	programBlocks,
	programs,
	programWeeks,
	setRecords,
	workouts,
	workoutSubstitutions
} from '../schema';
import type { Executor } from '../types';

export type WorkoutRow = typeof workouts.$inferSelect;
export type SetRow = typeof setRecords.$inferSelect;
export type SubstitutionRow = typeof workoutSubstitutions.$inferSelect;
export type NewWorkout = typeof workouts.$inferInsert;
export type NewSet = typeof setRecords.$inferInsert;
export type NewSubstitution = typeof workoutSubstitutions.$inferInsert;

/** What a create left stored: the row, and false when its device id was already stored. */
export interface Stored<Row> {
	row: Row;
	created: boolean;
}

/** The content columns an edit may change (never the owner, the workout or the device id). */
export type SetEdit = Pick<
	NewSet,
	| 'weight'
	| 'unit'
	| 'reps'
	| 'missedReps'
	| 'seconds'
	| 'metres'
	| 'rpe'
	| 'isWarmup'
	| 'isExtra'
	| 'isSkipped'
	| 'e1rmKg'
>;
export type WorkoutEdit = Pick<
	NewWorkout,
	'status' | 'finishedAt' | 'durationSeconds' | 'sessionRpe' | 'notes'
>;

interface Lookup {
	/** Lock the row for the rest of the transaction (SELECT … FOR UPDATE). */
	lock?: boolean;
}

export function createTrainingLogRepository(db: Executor) {
	/** Run `write` in a transaction whose audit actor is `actor`. */
	const asActor = <T>(actor: Decider, write: (tx: Executor) => Promise<T>): Promise<T> =>
		db.transaction(async (tx) => {
			await tx.execute(sql`select set_config(${AUDIT_ACTOR_SETTING}, ${actor}, true)`);
			return write(tx);
		});

	const repo = {
		async workout(ownerId: string, clientId: string, { lock }: Lookup = {}) {
			const query = db
				.select()
				.from(workouts)
				.where(and(eq(workouts.ownerId, ownerId), eq(workouts.clientId, clientId)));
			const [row] = await (lock ? query.for('update') : query);
			return row ?? null;
		},

		async set(ownerId: string, clientMutationId: string, { lock }: Lookup = {}) {
			const query = db
				.select()
				.from(setRecords)
				.where(
					and(eq(setRecords.ownerId, ownerId), eq(setRecords.clientMutationId, clientMutationId))
				);
			const [row] = await (lock ? query.for('update') : query);
			return row ?? null;
		},

		async substitution(ownerId: string, clientMutationId: string) {
			const [row] = await db
				.select()
				.from(workoutSubstitutions)
				.where(
					and(
						eq(workoutSubstitutions.ownerId, ownerId),
						eq(workoutSubstitutions.clientMutationId, clientMutationId)
					)
				);
			return row ?? null;
		},

		/** Null only when another owner's row holds the device id. */
		async insertWorkout(values: NewWorkout): Promise<Stored<WorkoutRow> | null> {
			const [row] = await db
				.insert(workouts)
				.values(values)
				.onConflictDoNothing({ target: workouts.clientId })
				.returning();
			if (row) return { row, created: true };
			const stored = await repo.workout(values.ownerId, values.clientId);
			return stored && { row: stored, created: false };
		},

		async insertSet(values: NewSet): Promise<Stored<SetRow> | null> {
			const [row] = await db
				.insert(setRecords)
				.values(values)
				.onConflictDoNothing({ target: setRecords.clientMutationId })
				.returning();
			if (row) return { row, created: true };
			const stored = await repo.set(values.ownerId, values.clientMutationId);
			return stored && { row: stored, created: false };
		},

		async insertSubstitution(values: NewSubstitution): Promise<Stored<SubstitutionRow> | null> {
			const [row] = await db
				.insert(workoutSubstitutions)
				.values(values)
				.onConflictDoNothing({ target: workoutSubstitutions.clientMutationId })
				.returning();
			if (row) return { row, created: true };
			const stored = await repo.substitution(values.ownerId, values.clientMutationId);
			return stored && { row: stored, created: false };
		},

		async updateWorkout(id: string, values: WorkoutEdit, actor: Decider): Promise<WorkoutRow> {
			return asActor(actor, async (tx) => {
				const [row] = await tx.update(workouts).set(values).where(eq(workouts.id, id)).returning();
				return row!;
			});
		},

		async updateSet(id: number, values: SetEdit, actor: Decider): Promise<SetRow> {
			return asActor(actor, async (tx) => {
				const [row] = await tx
					.update(setRecords)
					.set(values)
					.where(eq(setRecords.id, id))
					.returning();
				return row!;
			});
		},

		async softDeleteSet(id: number, at: Date, actor: Decider): Promise<SetRow> {
			return asActor(actor, async (tx) => {
				const [row] = await tx
					.update(setRecords)
					.set({ deletedAt: at })
					.where(eq(setRecords.id, id))
					.returning();
				return row!;
			});
		},

		/** A workout and all its sets in order (set_records_workout_order_idx), deleted ones too. */
		async workoutWithSets(ownerId: string, clientId: string) {
			const workout = await repo.workout(ownerId, clientId);
			if (!workout) return null;
			const sets = await db
				.select()
				.from(setRecords)
				.where(eq(setRecords.workoutId, workout.id))
				.orderBy(asc(setRecords.exercisePosition), asc(setRecords.setIndex), asc(setRecords.id));
			return { workout, sets };
		},

		/** A planned session's lineage and program, when the session is in one of the owner's. */
		async plannedSessionLink(ownerId: string, sessionId: string) {
			const [link] = await db
				.select({ plannedLineageId: plannedSessions.lineageId, programId: programs.id })
				.from(plannedSessions)
				.innerJoin(programWeeks, eq(programWeeks.id, plannedSessions.weekId))
				.innerJoin(programBlocks, eq(programBlocks.id, programWeeks.blockId))
				.innerJoin(programs, eq(programs.id, programBlocks.programId))
				.where(and(eq(plannedSessions.id, sessionId), eq(programs.ownerId, ownerId)));
			return link ?? null;
		}
	};
	return repo;
}
