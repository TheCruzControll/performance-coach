/**
 * Training history persistence: runs queries/history.ts's builders one query at a time, so the
 * plan db:explain measures is the plan the app runs. Plain data access: validation, the owner's
 * calendar and the metrics belong to src/lib/server/services/training/history.ts.
 */
import type { IsoDate } from '../../../domain/calendar';
import {
	activeWorkouts,
	bestE1rms,
	completedWorkoutsFor,
	completedWorkoutsPage,
	exerciseHistory,
	lastPerformances,
	lastSessionSetsFor,
	mostReps,
	repMaxes,
	runsInRange,
	sessionsInRange,
	setsInRange,
	workoutsInRange,
	type ExerciseIds,
	type InstantRange
} from '../queries/history';
import type { SessionRow } from '../queries/programs';
import type { Executor } from '../types';

export type * from '../queries/history';

export function createHistoryRepository(db: Executor) {
	return {
		async exerciseHistory(
			ownerId: string,
			exerciseId: string,
			page: { before?: number; limit: number }
		) {
			return exerciseHistory(db, ownerId, exerciseId, page);
		},

		async lastPerformances(ownerId: string, exerciseId: string, count: number) {
			return lastPerformances(db, ownerId, exerciseId, count);
		},

		/** Each exercise's last completed session before `before`, its sets in workout order. */
		async lastSessionSets(ownerId: string, exerciseIds: readonly string[], before: Date) {
			if (!exerciseIds.length) return [];
			return lastSessionSetsFor(db, ownerId, exerciseIds, before);
		},

		/**
		 * For one exercise, a list of them, or every exercise the owner can see; from sets performed
		 * before `before`, when given.
		 */
		async personalRecords(ownerId: string, exerciseId?: ExerciseIds, before?: Date) {
			if (Array.isArray(exerciseId) && !exerciseId.length) return { bestE1rms: [], repMaxes: [] };
			return {
				bestE1rms: await bestE1rms(db, ownerId, exerciseId, before),
				repMaxes: await repMaxes(db, ownerId, exerciseId, before)
			};
		},

		/** These exercises' most reps in one set with no weight added, performed before `before`. */
		async mostReps(ownerId: string, exerciseIds: readonly string[], before: Date) {
			if (!exerciseIds.length) return [];
			return mostReps(db, ownerId, exerciseIds, before);
		},

		async setsInRange(ownerId: string, range: InstantRange) {
			return setsInRange(db, ownerId, range);
		},

		async runsInRange(ownerId: string, range: InstantRange) {
			return runsInRange(db, ownerId, range);
		},

		/** The owner's workouts in progress, newest first, at most `limit`. */
		async activeWorkouts(ownerId: string, limit: number) {
			return activeWorkouts(db, ownerId, limit);
		},

		/** Each lineage's newest completed workout, by client id; lineages without one are absent. */
		async completedWorkoutsFor(ownerId: string, lineages: string[]): Promise<Map<string, string>> {
			if (!lineages.length) return new Map();
			const rows = await completedWorkoutsFor(db, ownerId, lineages);
			return new Map(rows.flatMap((row) => (row.lineage ? [[row.lineage, row.id] as const] : [])));
		},

		/** The owner's completed workouts, newest first, `limit` at a time after `before`. */
		async completedWorkoutsPage(
			ownerId: string,
			page: { before?: string; startedBefore?: Date; limit: number }
		) {
			return completedWorkoutsPage(db, ownerId, page);
		},

		/** A date range's planned sessions (none without a version) and logged workouts. */
		async sessionsInRange(
			ownerId: string,
			versionId: string | null,
			from: IsoDate,
			to: IsoDate,
			logged: InstantRange
		) {
			if (versionId === null) {
				return { planned: [] as SessionRow[], logged: await workoutsInRange(db, ownerId, logged) };
			}
			const q = sessionsInRange(db, ownerId, versionId, from, to, logged);
			return { planned: await q.planned, logged: await q.logged };
		}
	};
}
