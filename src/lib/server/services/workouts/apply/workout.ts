/**
 * workout.start, update, finish and abandon, mapped from wire format v1 onto M3's log service
 * (services/training/log.ts) in the mutation's transaction.
 *
 * - start: M3's startWorkout under the mutation's id (the workout's client id), with the kit's
 *   pinned planned session, which M3 checks against the lineage and program the device names. A
 *   planned session the owner does not have is refused at payload.plannedSessionId, never
 *   deferred: no later change creates one, so the owner keeps the workout unplanned (Fix).
 * - finish and abandon: M3's finishWorkout, at the mutation's `at`. Abandon is finishWorkout's
 *   'abandoned' status with no summary fields.
 * - update: the one write M3 lacks, notes, session RPE and duration while the workout runs (or
 *   after it ends): absolute values, a no-op skipped, one audit row for a real change.
 */
import { finishWorkout, startWorkout } from '../../training/log';
import { TrainingInputError, TrainingNotFoundError } from '../../training/shared';
import { createWorkoutSyncRepository } from '../../../db/repositories/workout-sync';
import type { Handlers } from './handler';

type WorkoutType = 'workout.start' | 'workout.update' | 'workout.finish' | 'workout.abandon';

export const workoutHandlers: Handlers<WorkoutType> = {
	async 'workout.start'(m, { ownerId, deps }) {
		const { plannedLineage, ...start } = m.payload;
		try {
			await startWorkout(
				ownerId,
				{ ...start, plannedLineageId: plannedLineage, clientId: m.id, startedAt: m.at },
				deps
			);
		} catch (err) {
			if (!(err instanceof TrainingNotFoundError)) throw err;
			throw new TrainingInputError({ plannedSessionId: 'No such planned session' });
		}
	},

	async 'workout.update'(m, { ownerId, deps }) {
		const repo = createWorkoutSyncRepository(deps.db);
		const workout = await repo.lockWorkout(ownerId, m.workoutId);
		if (!workout) throw new TrainingNotFoundError('workout');
		const changes = Object.entries(m.payload).filter(
			([field, value]) => value !== undefined && workout[field as keyof typeof workout] !== value
		);
		if (changes.length === 0) return;
		await repo.updateWorkoutFields(workout.id, Object.fromEntries(changes), deps.source);
	},

	async 'workout.finish'(m, { ownerId, deps }) {
		await finishWorkout(
			ownerId,
			m.workoutId,
			{ ...m.payload, status: 'completed', finishedAt: m.at },
			deps
		);
	},

	async 'workout.abandon'(m, { ownerId, deps }) {
		await finishWorkout(ownerId, m.workoutId, { status: 'abandoned', finishedAt: m.at }, deps);
	}
};
