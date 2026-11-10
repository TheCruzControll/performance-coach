/**
 * Weekly and cycle review persistence (M6): runs queries/reviews.ts's builders one query at a
 * time, and the writes the review guards allow (drizzle/0029_reviews_guards.sql). Plain data
 * access: what a review holds and when it may change belong to services/reviews/store.ts.
 * - insert is idempotent for a live week or block: ON CONFLICT on the partial live index does
 *   nothing, and the live row is returned instead.
 * - supersede marks the live row with the next revision's pre-generated id, then inserts that
 *   revision (superseded_by is deferred), on one transaction.
 * - The set-once writes (narrative, proposal, next version) update only a live row whose field is
 *   still null, so a second attempt changes no row (null) and never reaches the guard.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import * as q from '../queries/reviews';
import { cycleReviews, programVersions, weeklyReviews } from '../schema';
import type { Executor } from '../types';

export type WeeklyReviewRow = typeof weeklyReviews.$inferSelect;
export type CycleReviewRow = typeof cycleReviews.$inferSelect;
export type NewWeeklyReviewRow = typeof weeklyReviews.$inferInsert;
export type NewCycleReviewRow = typeof cycleReviews.$inferInsert;
/** A revision's content: everything but its identity, revision and lifecycle. */
type Identity = 'id' | 'ownerId' | 'revision' | 'supersededAt' | 'supersededBy';
export type WeeklyRevision = Omit<NewWeeklyReviewRow, Identity | 'weekStartsOn'>;
export type CycleRevision = Omit<NewCycleReviewRow, Identity | 'programId' | 'blockLineageId'>;
export interface Narrative {
	narrative: string;
	runId: string;
	threadId: string;
	at: Date;
}

const first = async <T>(rows: Promise<T[]>): Promise<T | null> => (await rows)[0] ?? null;
const tables = { weekly: weeklyReviews, cycle: cycleReviews } as const;

export function createReviewsRepository(db: Executor) {
	/** Set `set` on the owner's live review `id` where `unset` is still null; null if no row. */
	const setOnce = async (
		kind: q.ReviewKind,
		ownerId: string,
		id: string,
		unset: 'narrative' | 'proposalId' | 'nextVersionId',
		set: Record<string, unknown>,
		also?: ReturnType<typeof sql>
	) => {
		const t = tables[kind];
		const column = unset === 'nextVersionId' ? cycleReviews.nextVersionId : t[unset];
		return first(
			db
				.update(t)
				.set(set)
				.where(
					and(eq(t.id, id), eq(t.ownerId, ownerId), isNull(t.supersededAt), isNull(column), also)
				)
				.returning({ id: t.id })
		);
	};

	return {
		weeklyReview: (ownerId: string, id: string) => first(q.weeklyReview(db, ownerId, id)),
		cycleReview: (ownerId: string, id: string) => first(q.cycleReview(db, ownerId, id)),
		liveWeeklyReview: (ownerId: string, weekStartsOn: string) =>
			first(q.liveWeeklyReview(db, ownerId, weekStartsOn)),
		liveCycleReview: (ownerId: string, programId: string, blockLineageId: string) =>
			first(q.liveCycleReview(db, ownerId, programId, blockLineageId)),
		reviewsPage: async (ownerId: string, page: { before?: q.ReviewsKeyset; limit: number }) =>
			q.reviewsPage(db, ownerId, page),
		proposalHead: async (ownerId: string, proposalId: string) =>
			(await q.proposalChain(db, ownerId, proposalId))[0] ?? null,
		narrativeMessages: async (ownerId: string, threadId: string, runId: string) =>
			q.narrativeMessages(db, ownerId, threadId, runId),

		/** Store revision 1 of a week's review, or return the live one: `created` says which. */
		async insertWeekly(values: Omit<NewWeeklyReviewRow, Identity> & { ownerId: string }) {
			const t = weeklyReviews;
			const row = await first(
				db
					.insert(t)
					.values(values)
					.onConflictDoNothing({
						target: [t.ownerId, t.weekStartsOn],
						where: sql`${t.supersededAt} is null`
					})
					.returning()
			);
			if (row) return { row, created: true };
			const live = await first(q.liveWeeklyReview(db, values.ownerId, values.weekStartsOn));
			return { row: live!, created: false };
		},

		/** Store revision 1 of a block's review, or return the live one. */
		async insertCycle(values: Omit<NewCycleReviewRow, Identity> & { ownerId: string }) {
			const t = cycleReviews;
			const row = await first(
				db
					.insert(t)
					.values(values)
					.onConflictDoNothing({
						target: [t.programId, t.blockLineageId],
						where: sql`${t.supersededAt} is null`
					})
					.returning()
			);
			if (row) return { row, created: true };
			const { ownerId, programId, blockLineageId } = values;
			const live = await first(q.liveCycleReview(db, ownerId, programId, blockLineageId));
			return { row: live!, created: false };
		},

		/** Replace the owner's live weekly review `id` with revision n + 1; null if not live. */
		supersedeWeekly: (ownerId: string, id: string, values: WeeklyRevision, at: Date) =>
			db.transaction(async (tx) => {
				const t = weeklyReviews;
				const next = crypto.randomUUID();
				const old = await first(
					tx
						.update(t)
						.set({ supersededAt: at, supersededBy: next, updatedAt: at })
						.where(and(eq(t.id, id), eq(t.ownerId, ownerId), isNull(t.supersededAt)))
						.returning({ weekStartsOn: t.weekStartsOn, revision: t.revision })
				);
				if (!old) return null;
				const row = { ...values, ...old, id: next, ownerId, revision: old.revision + 1 };
				return (await first(tx.insert(t).values(row).returning()))!;
			}),

		/** Replace the owner's live cycle review `id` with revision n + 1; null if not live. */
		supersedeCycle: (ownerId: string, id: string, values: CycleRevision, at: Date) =>
			db.transaction(async (tx) => {
				const t = cycleReviews;
				const next = crypto.randomUUID();
				const old = await first(
					tx
						.update(t)
						.set({ supersededAt: at, supersededBy: next, updatedAt: at })
						.where(and(eq(t.id, id), eq(t.ownerId, ownerId), isNull(t.supersededAt)))
						.returning({
							programId: t.programId,
							blockLineageId: t.blockLineageId,
							revision: t.revision
						})
				);
				if (!old) return null;
				const row = { ...values, ...old, id: next, ownerId, revision: old.revision + 1 };
				return (await first(tx.insert(t).values(row).returning()))!;
			}),

		setNarrative: (kind: q.ReviewKind, ownerId: string, id: string, n: Narrative) =>
			setOnce(kind, ownerId, id, 'narrative', {
				narrative: n.narrative,
				narrativeRunId: n.runId,
				narrativeThreadId: n.threadId,
				narratedAt: n.at,
				updatedAt: n.at
			}),

		linkProposal: (kind: q.ReviewKind, ownerId: string, id: string, proposalId: string, at: Date) =>
			setOnce(kind, ownerId, id, 'proposalId', { proposalId, updatedAt: at }),

		/** Name the version that planned the next block: one of the reviewed program's. */
		setNextVersion: (ownerId: string, id: string, versionId: string, at: Date) =>
			setOnce(
				'cycle',
				ownerId,
				id,
				'nextVersionId',
				{ nextVersionId: versionId, updatedAt: at },
				sql`exists (select 1 from ${programVersions} where ${programVersions.id} = ${versionId}::uuid and ${programVersions.programId} = ${cycleReviews.programId})`
			)
	};
}
