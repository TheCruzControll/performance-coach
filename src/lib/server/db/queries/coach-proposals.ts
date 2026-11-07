/**
 * Coach proposal read builders (M5, PRD §14): each one keyed query that
 * repositories/coach-proposals.ts runs, shaped for the indexes in schema/coaching.ts.
 * - Every predicate repeats the owner, so a proposal is found only through its owner: someone
 *   else's id reads as no row at all.
 * - COACH_PROPOSAL_INDEXES names the index each builder is shaped for; coach-explain (m5/54) adds
 *   them to `pnpm db:explain`.
 * Nothing runs until a builder is awaited; await them in turn on one connection.
 */
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { ProposalStatus } from '../../../domain/training/vocabulary';
import { coachProposals, programVersions } from '../schema';
import type { Executor } from '../types';

/** The index each builder is shaped for. */
export const COACH_PROPOSAL_INDEXES = {
	proposal: 'coach_proposals_pkey',
	lockProposal: 'coach_proposals_pkey',
	openDuplicate: 'coach_proposals_owner_status_idx',
	proposalPage: 'coach_proposals_owner_status_idx',
	decidedSince: 'coach_proposals_owner_status_idx'
} as const;

/** A proposal as its card, the inbox and get_coach_proposals read it (no payload). */
export const proposalViewColumns = {
	id: coachProposals.id,
	kind: coachProposals.kind,
	status: coachProposals.status,
	title: coachProposals.title,
	summary: coachProposals.summary,
	rationale: coachProposals.rationale,
	diff: coachProposals.diff,
	impact: coachProposals.impact,
	programId: coachProposals.programId,
	baseVersionId: coachProposals.baseVersionId,
	appliedVersionId: coachProposals.appliedVersionId,
	appliedVersionNumber: programVersions.number,
	appliedRef: coachProposals.appliedRef,
	threadId: coachProposals.threadId,
	revisionOf: coachProposals.revisionOf,
	decisionNote: coachProposals.decisionNote,
	supersededReason: coachProposals.supersededReason,
	createdAt: coachProposals.createdAt,
	closedAt: coachProposals.closedAt
};

const own = (ownerId: string, id: string) =>
	and(eq(coachProposals.id, id), eq(coachProposals.ownerId, ownerId));

/** Proposals with the version applying them made, if any. */
const views = (db: Executor) =>
	db
		.select(proposalViewColumns)
		.from(coachProposals)
		.leftJoin(programVersions, eq(programVersions.id, coachProposals.appliedVersionId));

/** One of the owner's proposals. */
export function proposal(db: Executor, ownerId: string, id: string) {
	return views(db).where(own(ownerId, id));
}

/** One of the owner's proposals, whole and locked for the rest of the transaction. */
export function lockProposal(db: Executor, ownerId: string, id: string) {
	return db.select().from(coachProposals).where(own(ownerId, id)).for('update');
}

/** The owner's open proposal of the same kind, payload and base, if one is still waiting. */
export function openDuplicate(
	db: Executor,
	ownerId: string,
	{
		kind,
		payloadHash,
		baseVersionId
	}: { kind: string; payloadHash: string; baseVersionId: string | null }
) {
	return db
		.select({ id: coachProposals.id })
		.from(coachProposals)
		.where(
			and(
				eq(coachProposals.ownerId, ownerId),
				eq(coachProposals.status, 'proposed'),
				eq(coachProposals.kind, kind),
				eq(coachProposals.payloadHash, payloadHash),
				baseVersionId === null
					? isNull(coachProposals.baseVersionId)
					: eq(coachProposals.baseVersionId, baseVersionId)
			)
		)
		.limit(1);
}

const cursor = alias(coachProposals, 'cursor');

export interface ProposalPage {
	status?: ProposalStatus;
	/** Only these proposals (well-formed uuids). */
	ids?: readonly string[];
	/** The last proposal id of the previous page. */
	before?: string;
	limit: number;
}

/**
 * The owner's proposals, newest first, `limit` at a time. Keyset pagination on (created_at, id):
 * `before`'s own row gives the time to continue from, so a cursor that is not one of the owner's
 * proposals gives an empty page.
 */
export function proposalPage(db: Executor, ownerId: string, page: ProposalPage) {
	const { status, ids, before, limit } = page;
	const after =
		before === undefined
			? undefined
			: sql`(${coachProposals.createdAt}, ${coachProposals.id}) < ((${db
					.select({ at: cursor.createdAt })
					.from(cursor)
					.where(and(eq(cursor.id, before), eq(cursor.ownerId, ownerId)))}), ${before}::uuid)`;
	return views(db)
		.where(
			and(
				eq(coachProposals.ownerId, ownerId),
				status === undefined ? undefined : eq(coachProposals.status, status),
				ids === undefined ? undefined : inArray(coachProposals.id, [...ids]),
				after
			)
		)
		.orderBy(desc(coachProposals.createdAt), desc(coachProposals.id))
		.limit(limit);
}

/** The owner's proposals decided after `since`, most recently decided first, `limit` of them. */
export function decidedSince(db: Executor, ownerId: string, since: Date, limit: number) {
	return db
		.select({ id: coachProposals.id, kind: coachProposals.kind, status: coachProposals.status })
		.from(coachProposals)
		.where(and(eq(coachProposals.ownerId, ownerId), gt(coachProposals.closedAt, since)))
		.orderBy(desc(coachProposals.closedAt), desc(coachProposals.id))
		.limit(limit);
}
