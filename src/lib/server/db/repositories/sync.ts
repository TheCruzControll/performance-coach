/**
 * The sync ledger's persistence (schema/sync.ts): claim a mutation id, and ask which ids are
 * applied. Plain data access: the sync endpoint decides what a claim means for its batch.
 *
 * - claimMutation runs in the transaction that applies the mutation's effect, first, so the
 *   claim and the effect commit or roll back together. A rolled-back claim leaves no row, and
 *   the mutation can be corrected and re-sent under the same id.
 * - A concurrent claim of the same id waits on the first's uncommitted key: it reads 'seen' once
 *   that commits, or claims the id itself if that rolls back. Postgres's unique index decides, so
 *   no lock is taken by hand.
 * - Reads are by owner and the primary key, so a mutation id never answers for another owner.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { syncMutations } from '../schema';
import type { Executor } from '../types';

export type SyncMutationRow = typeof syncMutations.$inferSelect;
/** What a claim records; applied_at is the server's. */
export type NewSyncMutation = Omit<typeof syncMutations.$inferInsert, 'appliedAt'>;

/** 'claimed': this transaction records the id first. 'seen': it was already applied. */
export type Claim = 'claimed' | 'seen';

/**
 * Record `row.mutationId` as applied, in `tx`, the transaction that applies its effect. 'seen'
 * means the id is already in the ledger: apply nothing, and leave the stored row as it is.
 */
export async function claimMutation(tx: Executor, row: NewSyncMutation): Promise<Claim> {
	const [claimed] = await tx
		.insert(syncMutations)
		.values(row)
		.onConflictDoNothing({ target: syncMutations.mutationId })
		.returning({ mutationId: syncMutations.mutationId });
	return claimed ? 'claimed' : 'seen';
}

/** The ledger's type for an id the owner discarded on the device (claimDiscarded). */
export const DISCARDED_TYPE = 'discarded';

/**
 * Ids the owner discarded on the device, recorded so a request still carrying one (a POST the
 * device stopped waiting for) answers 'duplicate' and applies nothing. An id already applied keeps
 * its row. One statement; the device sends only ids, so the row names the id as its own entity.
 */
export async function claimDiscarded(
	db: Executor,
	ownerId: string,
	ids: readonly string[],
	requestId: string | null,
	at: Date
): Promise<void> {
	if (ids.length === 0) return;
	const rows = ids.map((mutationId) => ({
		mutationId,
		ownerId,
		type: DISCARDED_TYPE,
		entityId: mutationId,
		clientAt: at,
		requestId
	}));
	await db
		.insert(syncMutations)
		.values(rows)
		.onConflictDoNothing({ target: syncMutations.mutationId });
}

export function createSyncRepository(db: Executor) {
	return {
		/** The ids among `ids` that the owner's ledger holds: those applied. */
		async appliedIn(ownerId: string, ids: readonly string[]): Promise<Set<string>> {
			if (ids.length === 0) return new Set();
			const rows = await db
				.select({ mutationId: syncMutations.mutationId })
				.from(syncMutations)
				.where(
					and(eq(syncMutations.ownerId, ownerId), inArray(syncMutations.mutationId, [...ids]))
				);
			return new Set(rows.map((row) => row.mutationId));
		}
	};
}

export type SyncRepository = ReturnType<typeof createSyncRepository>;
