/**
 * Coaching memory reads: runs queries/coach-memory.ts's builders one query at a time. Plain data
 * access: shaping the snapshot belongs to src/lib/server/services/coach/memory.ts.
 */
import * as q from '../queries/coach-memory';
import type { Executor } from '../types';

export type * from '../queries/coach-memory';

export function createCoachMemoryRepository(db: Executor) {
	return {
		/** Null for an unknown owner. */
		profileSections: async (ownerId: string): Promise<q.ProfileSectionsRow | null> =>
			(await q.profileSections(db, ownerId))[0] ?? null
	};
}
