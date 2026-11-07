/**
 * Coach proposal persistence: runs queries/coach-proposals.ts's builders one query at a time,
 * and the insert and lifecycle update the proposal guards allow (drizzle/0026). Plain data
 * access: validation, de-duplication, revisions and decisions belong to
 * src/lib/server/services/coach/proposals.ts.
 */
import { and, eq, sql } from 'drizzle-orm';
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

		insertProposal: async (values: NewProposalRow) =>
			(await first(db.insert(coachProposals).values(values).returning({ id: coachProposals.id })))!
				.id,

		/** Record a decision on one of the owner's proposals. */
		decide: async (ownerId: string, id: string, set: ProposalDecision) => {
			await db
				.update(coachProposals)
				.set(set)
				.where(and(eq(coachProposals.id, id), eq(coachProposals.ownerId, ownerId)));
		}
	};
}
