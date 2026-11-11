/**
 * Coaching memory reads: runs queries/coach-memory.ts's builders one query at a time. Plain data
 * access: shaping the snapshot belongs to src/lib/server/services/coach/memory.ts and
 * memory-records.ts.
 */
import * as q from '../queries/coach-memory';
import type { Executor } from '../types';

export type * from '../queries/coach-memory';

export function createCoachMemoryRepository(db: Executor) {
	return {
		/** Null for an unknown owner. */
		profileSections: async (ownerId: string): Promise<q.ProfileSectionsRow | null> =>
			(await q.profileSections(db, ownerId))[0] ?? null,
		painReportsSince: (ownerId: string, since: string, limit: number) =>
			q.painReportsSince(db, ownerId, since, limit),
		recoveryNotesSince: (ownerId: string, since: string, limit: number) =>
			q.recoveryNotesSince(db, ownerId, since, limit),
		latestWeeklyReviews: (ownerId: string, limit: number) =>
			q.latestWeeklyReviews(db, ownerId, limit),
		latestCycleReview: async (ownerId: string): Promise<q.MemoryReviewRow | null> =>
			(await q.latestCycleReview(db, ownerId))[0] ?? null,
		recentDecisions: (ownerId: string, limit: number) => q.recentDecisions(db, ownerId, limit),
		recentProposals: (ownerId: string, page: Parameters<typeof q.recentProposals>[2]) =>
			q.recentProposals(db, ownerId, page),
		recentNotes: (
			ownerId: string,
			kind: string,
			limit: number,
			hiddenEntries?: readonly string[]
		) => q.recentNotes(db, ownerId, kind, limit, hiddenEntries)
	};
}
