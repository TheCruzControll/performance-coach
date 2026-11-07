/**
 * The canonical workout reads (the offline workout sync ADR, 'Reconciliation'): what the server
 * holds, as wire format v1 shapes it, for the device to reconcile with and to continue a workout
 * started on another device.
 *
 * - getCanonicalWorkout: one workout's rows by client id, tombstones included, with the exercises
 *   they name: the same CanonicalWorkout the sync results carry (dto.ts), read through keyed
 *   lookups (repositories/workout-sync.ts canonicalRows, over M3's workoutWithSets). A malformed id,
 *   an unknown one and another owner's all read as null, which the route answers 404.
 * - listActiveWorkouts: the owner's workouts in progress, newest first, through M3's history
 *   builder (queries/history.ts activeWorkouts), so history queries keep one definition.
 * - Every query is awaited in turn on one Executor (#62).
 */
import type { ActiveWorkouts, CanonicalWorkout } from '../../../domain/workout/index';
import { getDb } from '../../db';
import { createHistoryRepository } from '../../db/repositories/history';
import { createWorkoutSyncRepository } from '../../db/repositories/workout-sync';
import type { Executor } from '../../db/types';
import { getExercisesByIds } from '../exercises/index';
import { isUuid } from '../ids';
import { exerciseIdsOf, toCanonicalWorkout } from './dto';

/**
 * At most this many workouts in progress are listed. One owner usually has one; a few more are
 * workouts left unfinished on several devices, and Today offers the newest.
 */
export const ACTIVE_WORKOUTS_LIMIT = 10;

export interface ReadDeps {
	db?: Executor;
}

/** The owner's workout with this client id, as the device stores it; null when there is none. */
export async function getCanonicalWorkout(
	ownerId: string,
	workoutClientId: string,
	{ db = getDb() }: ReadDeps = {}
): Promise<CanonicalWorkout | null> {
	if (!isUuid(workoutClientId)) return null;
	const rows = await createWorkoutSyncRepository(db).canonicalRows(ownerId, workoutClientId);
	if (!rows) return null;
	const exercises = await getExercisesByIds(ownerId, exerciseIdsOf(rows), { db });
	return toCanonicalWorkout(rows, exercises);
}

/** The owner's workouts in progress, newest first. */
export async function listActiveWorkouts(
	ownerId: string,
	{ db = getDb() }: ReadDeps = {}
): Promise<ActiveWorkouts> {
	const rows = await createHistoryRepository(db).activeWorkouts(ownerId, ACTIVE_WORKOUTS_LIMIT);
	return {
		v: 1,
		workouts: rows.map(({ startedAt, ...row }) => ({ ...row, startedAt: startedAt.toISOString() }))
	};
}
