/**
 * Training history persistence: runs queries/history.ts's builders one query at a time, so the
 * plan db:explain measures is the plan the app runs. Plain data access: validation, the owner's
 * calendar and the metrics belong to src/lib/server/services/training/history.ts.
 */
import type { IsoDate } from '../../../domain/calendar';
import {
	activeWorkouts,
	bestE1rms,
	exerciseHistory,
	lastPerformances,
	repMaxes,
	runsInRange,
	sessionsInRange,
	setsInRange,
	workoutsInRange,
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

		/** For one exercise, or for every exercise the owner can see. */
		async personalRecords(ownerId: string, exerciseId?: string) {
			return {
				bestE1rms: await bestE1rms(db, ownerId, exerciseId),
				repMaxes: await repMaxes(db, ownerId, exerciseId)
			};
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
