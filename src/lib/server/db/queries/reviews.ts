/**
 * Weekly and cycle review read builders (M6): each one keyed query that repositories/reviews.ts
 * runs, shaped for the indexes in schema/coaching.ts.
 * - Every predicate repeats the owner, so a review is found only through its owner: someone
 *   else's id reads as no row at all. A partial index's predicate (superseded_at is null) is
 *   repeated so the plan can use it.
 * - REVIEW_INDEXES names the index each builder is shaped for. proposalChain and proposalHeads
 *   walk coach_proposals.revision_of, which has no index: the chain is short and the owner's
 *   proposals few, so their plans are recorded, never gated (null).
 * Nothing runs until a builder is awaited; await them in turn on one connection.
 */
import { and, asc, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import type { SupersededReason } from '../../../domain/coach/vocabulary';
import type { ProposalStatus } from '../../../domain/training/vocabulary';
import { coachMessages, coachThreads, cycleReviews, weeklyReviews } from '../schema';
import type { Executor } from '../types';

/** The index each builder is shaped for. */
export const REVIEW_INDEXES = {
	liveWeeklyReview: 'weekly_reviews_owner_week_uq',
	liveCycleReview: 'cycle_reviews_block_uq',
	weeklyReview: 'weekly_reviews_pkey',
	cycleReview: 'cycle_reviews_pkey',
	reviewsPage: { weekly: 'weekly_reviews_owner_week_uq', cycle: 'cycle_reviews_owner_ends_idx' },
	proposalChain: null,
	proposalHeads: null,
	narrativeMessages: 'coach_messages_thread_segment_seq_idx'
} as const;

/** Decision: the longest revision chain followed, a bound that no real chain comes near. */
export const PROPOSAL_CHAIN_MAX = 64;

const w = weeklyReviews;
const c = cycleReviews;

/** The owner's live review of the week starting `weekStartsOn`. */
export function liveWeeklyReview(db: Executor, ownerId: string, weekStartsOn: string) {
	return db
		.select()
		.from(w)
		.where(and(eq(w.ownerId, ownerId), eq(w.weekStartsOn, weekStartsOn), isNull(w.supersededAt)));
}

/** The owner's live review of a program's block. */
export function liveCycleReview(
	db: Executor,
	ownerId: string,
	programId: string,
	blockLineageId: string
) {
	return db
		.select()
		.from(c)
		.where(
			and(
				eq(c.programId, programId),
				eq(c.blockLineageId, blockLineageId),
				isNull(c.supersededAt),
				eq(c.ownerId, ownerId)
			)
		);
}

/** One of the owner's weekly reviews, any revision. */
export function weeklyReview(db: Executor, ownerId: string, id: string) {
	return db
		.select()
		.from(w)
		.where(and(eq(w.id, id), eq(w.ownerId, ownerId)));
}

/** One of the owner's cycle reviews, any revision. */
export function cycleReview(db: Executor, ownerId: string, id: string) {
	return db
		.select()
		.from(c)
		.where(and(eq(c.id, id), eq(c.ownerId, ownerId)));
}

/** Where the previous page stopped on each side; an absent side starts from its newest. */
export interface ReviewsKeyset {
	/** The last weekly review's Monday. */
	weekly?: string;
	/** The last cycle review's block end (null for one written before M6) and id. */
	cycle?: { endsOn: string | null; id: string };
}

export type ReviewKind = 'weekly' | 'cycle';

/**
 * The owner's live reviews of both kinds, newest period end first, `limit` of them, in one
 * statement. Each side reads its own index from its own keyset, `limit` at most, and the merge
 * orders by period end (a week ends on its Sunday), a block's review before the week ending on
 * the same day. A cycle review written before M6 has no block dates: those come last, by id.
 */
export function reviewsPage(
	db: Executor,
	ownerId: string,
	{ before = {}, limit }: { before?: ReviewsKeyset; limit: number }
) {
	const weekly = db
		.select({
			kind: sql<ReviewKind>`'weekly'`.as('kind'),
			id: sql<string>`${w.id}::text`.as('id'),
			startsOn: sql<string | null>`${w.weekStartsOn}::text`.as('starts_on'),
			endsOn: sql<string | null>`(${w.weekStartsOn} + 6)::text`.as('ends_on'),
			revision: sql<number>`${w.revision}`.as('revision'),
			snapshotVersion: sql<number>`${w.snapshotVersion}`.as('snapshot_version'),
			summary: sql<string>`${w.summary}`.as('summary')
		})
		.from(w)
		.where(
			and(
				eq(w.ownerId, ownerId),
				isNull(w.supersededAt),
				before.weekly === undefined ? undefined : sql`${w.weekStartsOn} < ${before.weekly}::date`
			)
		)
		.orderBy(sql`${w.weekStartsOn} desc`)
		.limit(limit);
	const key = before.cycle;
	let cycleAfter: SQL | undefined;
	if (key?.endsOn != null) {
		cycleAfter = sql`(${c.blockEndsOn} < ${key.endsOn}::date or (${c.blockEndsOn} = ${key.endsOn}::date and ${c.id} < ${key.id}::uuid) or ${c.blockEndsOn} is null)`;
	} else if (key) {
		cycleAfter = sql`(${c.blockEndsOn} is null and ${c.id} < ${key.id}::uuid)`;
	}
	const cycle = db
		.select({
			kind: sql<ReviewKind>`'cycle'`.as('kind'),
			id: sql<string>`${c.id}::text`.as('id'),
			startsOn: sql<string | null>`${c.blockStartsOn}::text`.as('starts_on'),
			endsOn: sql<string | null>`${c.blockEndsOn}::text`.as('ends_on'),
			revision: sql<number>`${c.revision}`.as('revision'),
			snapshotVersion: sql<number>`${c.snapshotVersion}`.as('snapshot_version'),
			summary: sql<string>`${c.summary}`.as('summary')
		})
		.from(c)
		.where(and(eq(c.ownerId, ownerId), isNull(c.supersededAt), cycleAfter))
		.orderBy(sql`${c.blockEndsOn} desc nulls last, ${c.id} desc`)
		.limit(limit);
	return weekly
		.unionAll(cycle)
		.orderBy(sql`ends_on desc nulls last, kind, id desc`)
		.limit(limit);
}

/** The newest revision a proposal's chain reaches, and how many revisions it took. */
export type ProposalHeadRow = {
	id: string;
	status: ProposalStatus;
	supersededReason: SupersededReason | null;
	appliedVersionId: string | null;
	appliedVersionNumber: number | null;
	depth: number;
};

/**
 * The head of the owner's proposal `proposalId`'s revision chain: a recursive walk forward over
 * coach_proposals.revision_of, taking the deepest revision (the newest of equals). No row when
 * the proposal is not the owner's.
 */
export async function proposalChain(
	db: Executor,
	ownerId: string,
	proposalId: string
): Promise<ProposalHeadRow[]> {
	const result = await db.execute<ProposalHeadRow>(sql`
		with recursive chain (id, depth) as (
			select p.id, 0 from coach_proposals p where p.id = ${proposalId}::uuid and p.owner_id = ${ownerId}::uuid
			union all
			select p.id, chain.depth + 1 from coach_proposals p
			join chain on p.revision_of = chain.id
			where p.owner_id = ${ownerId}::uuid and chain.depth < ${PROPOSAL_CHAIN_MAX}
		)
		select p.id::text as "id", p.status as "status", p.superseded_reason as "supersededReason",
			p.applied_version_id::text as "appliedVersionId", v.number as "appliedVersionNumber",
			chain.depth as "depth"
		from chain
		join coach_proposals p on p.id = chain.id
		left join program_versions v on v.id = p.applied_version_id
		order by chain.depth desc, p.created_at desc, p.id desc
		limit 1`);
	return result.rows;
}

/** A chain's head, keyed by the proposal its walk started from. */
export type ProposalHeadOfRow = ProposalHeadRow & { rootId: string };

/**
 * proposalChain for several of the owner's proposals in one query: each one's head, keyed by the
 * proposal its walk started from. A proposal that is not the owner's has no row.
 */
export async function proposalHeads(
	db: Executor,
	ownerId: string,
	proposalIds: readonly string[]
): Promise<ProposalHeadOfRow[]> {
	const ids = sql.join(
		proposalIds.map((id) => sql`${id}::uuid`),
		sql`, `
	);
	const result = await db.execute<ProposalHeadOfRow>(sql`
		with recursive chain (root, id, depth) as (
			select p.id, p.id, 0 from coach_proposals p where p.id in (${ids}) and p.owner_id = ${ownerId}::uuid
			union all
			select chain.root, p.id, chain.depth + 1 from coach_proposals p
			join chain on p.revision_of = chain.id
			where p.owner_id = ${ownerId}::uuid and chain.depth < ${PROPOSAL_CHAIN_MAX}
		)
		select distinct on (chain.root) chain.root::text as "rootId", p.id::text as "id",
			p.status as "status", p.superseded_reason as "supersededReason",
			p.applied_version_id::text as "appliedVersionId", v.number as "appliedVersionNumber",
			chain.depth as "depth"
		from chain
		join coach_proposals p on p.id = chain.id
		left join program_versions v on v.id = p.applied_version_id
		order by chain.root, chain.depth desc, p.created_at desc, p.id desc`);
	return result.rows;
}

/**
 * The display rows the run `runId` wrote in the owner's thread `threadId`, in order: its
 * assistant answers, and what was shown of one that did not complete.
 */
export function narrativeMessages(db: Executor, ownerId: string, threadId: string, runId: string) {
	return db
		.select({
			seq: coachMessages.seq,
			kind: coachMessages.kind,
			status: coachMessages.status,
			display: coachMessages.display
		})
		.from(coachMessages)
		.innerJoin(
			coachThreads,
			and(eq(coachThreads.id, coachMessages.threadId), eq(coachThreads.ownerId, ownerId))
		)
		.where(
			and(
				eq(coachMessages.threadId, threadId),
				eq(coachMessages.ownerId, ownerId),
				eq(coachMessages.runId, runId),
				eq(coachMessages.role, 'assistant'),
				isNotNull(coachMessages.display)
			)
		)
		.orderBy(asc(coachMessages.segment), asc(coachMessages.seq));
}
