/**
 * Coach proposal persistence: runs queries/coach-proposals.ts's builders one query at a time,
 * and the insert and lifecycle update the proposal guards allow (drizzle/0026). Plain data
 * access: validation, de-duplication, revisions and decisions belong to
 * src/lib/server/services/coach/proposals.ts.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Transitioned } from '../../../domain/lifecycle';
import type { ProposalStatus } from '../../../domain/training/vocabulary';
import * as q from '../queries/coach-proposals';
import { coachProposals } from '../schema';
import type { Executor } from '../types';

export type ProposalViewRow = Awaited<ReturnType<typeof q.proposal>>[number];
export type ProposalRow = typeof coachProposals.$inferSelect;
export type NewProposalRow = typeof coachProposals.$inferInsert;
/** What a decision may change: the lifecycle columns, never the content. */
export type ProposalDecision = Partial<
	Pick<
		NewProposalRow,
		| 'status'
		| 'programId'
		| 'appliedVersionId'
		| 'appliedRef'
		| 'closedAt'
		| 'decisionNote'
		| 'supersededReason'
	>
> & { updatedAt: Date };

/** Advisory-lock key for creating one owner's proposals (727201–727202: exercises, programs). */
const PROPOSALS_LOCK = 727203;

const first = async <T>(rows: Promise<T[]>): Promise<T | null> => (await rows)[0] ?? null;

export function createCoachProposalsRepository(db: Executor) {
	return {
		proposal: (ownerId: string, id: string) => first(q.proposal(db, ownerId, id)),

		/** The whole row, locked for the transaction; null if not the owner's. */
		lockProposal: (ownerId: string, id: string) => first(q.lockProposal(db, ownerId, id)),

		/** Serialise this owner's proposal creation (its duplicate check) within the transaction. */
		async lockCreates(ownerId: string): Promise<void> {
			await db.execute(sql`select pg_advisory_xact_lock(${PROPOSALS_LOCK}, hashtext(${ownerId}))`);
		},

		openDuplicate: async (ownerId: string, of: Parameters<typeof q.openDuplicate>[2]) =>
			(await first(q.openDuplicate(db, ownerId, of)))?.id ?? null,

		proposalPage: async (ownerId: string, page: q.ProposalPage) =>
			q.proposalPage(db, ownerId, page),

		decidedSince: async (ownerId: string, since: Date, limit: number) =>
			q.decidedSince(db, ownerId, since, limit),

		threadProposals: async (
			ownerId: string,
			threadId: string,
			page: Parameters<typeof q.threadProposals>[3]
		) => q.threadProposals(db, ownerId, threadId, page),

		insertProposal: async (values: NewProposalRow) =>
			(await first(db.insert(coachProposals).values(values).returning({ id: coachProposals.id })))!
				.id,

		/**
		 * Record a decision on one of the owner's proposals: the move `t` (from transition(), so the
		 * PROPOSAL table saw it), only while the row is still in `t.from`. Callers hold its row lock,
		 * so a row that has moved is a bug, not a race.
		 */
		decide: async (
			ownerId: string,
			id: string,
			t: Transitioned<ProposalStatus>,
			set: Omit<ProposalDecision, 'status'>
		) => {
			const updated = await db
				.update(coachProposals)
				.set({ ...set, status: t.to })
				.where(
					and(
						eq(coachProposals.id, id),
						eq(coachProposals.ownerId, ownerId),
						eq(coachProposals.status, t.from)
					)
				)
				.returning({ id: coachProposals.id });
			if (updated.length === 0) throw new Error('coach proposal moved under its lock');
		}
	};
}
