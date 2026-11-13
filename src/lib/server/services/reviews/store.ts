/**
 * The reviews store (M6): the one owner-scoped way the review services store and read weekly and
 * cycle reviews (the M6 plan, 'Reviews are completed, not replaced' and 'Revision chain').
 * - Storing is idempotent for a live week or block; a refresh supersedes the live row with
 *   revision n + 1 and keeps both. The write-up, the proposal and the next version are each set
 *   once: a second attempt is a ReviewSetOnceError, a superseded review a ReviewSupersededError.
 * - Reads parse the snapshot by its version (domain/programming/review): 0 or a version this
 *   code does not know reads as legacy, with the summary only.
 * - A review's decision is always read from the head of its proposal's revision chain, never
 *   from the proposal it first linked: decisionState.
 * - narrativeBlocks reads the write-up's display rows from the run that wrote them, through the
 *   owner's thread.
 * - Someone else's review, a malformed id and no review at all are one ReviewNotFoundError.
 * Every query is awaited in turn, so a caller may pass a transaction.
 */
import { parseIsoDate, type IsoDate } from '../../../domain/calendar';
import {
	readCycleSnapshot,
	CYCLE_SNAPSHOT_VERSION,
	type CycleReviewSnapshot
} from '../../../domain/programming/review/cycle-snapshot';
import {
	readSnapshot,
	SNAPSHOT_VERSION,
	type ReadSnapshot,
	type WeeklyReviewSnapshot
} from '../../../domain/programming/review/snapshot';
import { getDb, type Executor } from '../../db';
import type { ProposalHeadRow, ReviewKind, ReviewsKeyset } from '../../db/queries/reviews';
import { createCoachProposalsRepository } from '../../db/repositories/coach-proposals';
import {
	createReviewsRepository,
	type CycleReviewRow,
	type CycleRevision,
	type NewCycleReviewRow,
	type NewWeeklyReviewRow,
	type WeeklyReviewRow,
	type WeeklyRevision
} from '../../db/repositories/reviews';
import { isUuid } from '../ids';

export type { ReviewKind, ReviewsKeyset };

export interface ReviewDeps {
	db?: Executor;
	now?: () => Date;
}

/** A history page's size: the default and the most one page may ask for. */
export const REVIEWS_PAGE = Object.freeze({ default: 20, max: 50 });

/**
 * Owner decision (open question 'refresh'): a review stored with no inputs digest (one written
 * before M6) is never called out of date, since nothing says what it was computed from.
 */
export const STALE_WITHOUT_DIGEST = false;

/** The superseded reason that means some of the head's sessions passed before it was accepted. */
export const PARTLY_PAST_REASON = 'sessions_passed';

export class ReviewNotFoundError extends Error {
	readonly what: string;
	constructor(what = 'review') {
		super(`${what} not found`);
		this.name = 'ReviewNotFoundError';
		this.what = what;
	}
}

/** The review's write-up, proposal or next version is already set; nothing was written. */
export class ReviewSetOnceError extends Error {
	readonly field: 'narrative' | 'proposal' | 'nextVersion';
	constructor(field: ReviewSetOnceError['field']) {
		super(`the review's ${field} is already set`);
		this.name = 'ReviewSetOnceError';
		this.field = field;
	}
}

/** A newer revision replaced the review: it never changes again. */
export class ReviewSupersededError extends Error {
	constructor() {
		super('the review was superseded by a newer revision');
		this.name = 'ReviewSupersededError';
	}
}

export class ReviewInputError extends Error {
	readonly field: string;
	constructor(field: string, message: string) {
		super(message);
		this.name = 'ReviewInputError';
		this.field = field;
	}
}

export type StoredWeeklyReview = WeeklyReviewRow & {
	kind: 'weekly';
	read: ReadSnapshot<WeeklyReviewSnapshot>;
};
export type StoredCycleReview = CycleReviewRow & {
	kind: 'cycle';
	read: ReadSnapshot<CycleReviewSnapshot>;
};
export type StoredReview = StoredWeeklyReview | StoredCycleReview;

/**
 * What the owner decided on a review's proposal, read from its chain's head. 'late' (M7) is a
 * replan head (a deload) whose week had no session still ahead at accept (sessions_passed): unlike
 * a program_adjustment's partly past head, nothing is left of it to decide.
 */
export type DecisionState =
	| { state: 'none' }
	| {
			state: 'undecided' | 'rejected' | 'partly_past' | 'accepted_waiting' | 'late';
			proposalId: string;
	  }
	| { state: 'applied'; proposalId: string; versionId: string | null; versionNumber: number | null }
	| { state: 'superseded'; proposalId: string; reason: string };

const resolve = (deps: ReviewDeps) => ({
	db: deps.db ?? getDb(),
	now: deps.now ?? (() => new Date())
});

const weekly = (row: WeeklyReviewRow): StoredWeeklyReview => ({
	...row,
	kind: 'weekly',
	read: readSnapshot(row)
});
const cycle = (row: CycleReviewRow): StoredCycleReview => ({
	...row,
	kind: 'cycle',
	read: readCycleSnapshot(row)
});

export async function storeWeeklyReview(
	ownerId: string,
	values: Omit<NewWeeklyReviewRow, 'id' | 'ownerId' | 'revision' | 'supersededAt' | 'supersededBy'>,
	deps: ReviewDeps = {}
): Promise<{ review: StoredWeeklyReview; created: boolean }> {
	const r = createReviewsRepository(resolve(deps).db);
	const { row, created } = await r.insertWeekly({ ...values, ownerId });
	return { review: weekly(row), created };
}

export async function storeCycleReview(
	ownerId: string,
	values: Omit<NewCycleReviewRow, 'id' | 'ownerId' | 'revision' | 'supersededAt' | 'supersededBy'>,
	deps: ReviewDeps = {}
): Promise<{ review: StoredCycleReview; created: boolean }> {
	const r = createReviewsRepository(resolve(deps).db);
	const { row, created } = await r.insertCycle({ ...values, ownerId });
	return { review: cycle(row), created };
}

export async function getWeeklyReview(ownerId: string, id: string, deps: ReviewDeps = {}) {
	const row = isUuid(id)
		? await createReviewsRepository(resolve(deps).db).weeklyReview(ownerId, id)
		: null;
	if (!row) throw new ReviewNotFoundError();
	return weekly(row);
}

export async function getCycleReview(ownerId: string, id: string, deps: ReviewDeps = {}) {
	const row = isUuid(id)
		? await createReviewsRepository(resolve(deps).db).cycleReview(ownerId, id)
		: null;
	if (!row) throw new ReviewNotFoundError();
	return cycle(row);
}

/**
 * Whether `key`, a review's page key (`w-<Monday>` or `c-<id>`, domain/coach/sources.ts
 * reviewKey), names one of the owner's reviews: what a review ref is checked against.
 */
export async function hasReview(ownerId: string, key: string, deps: ReviewDeps = {}) {
	const id = key.slice(2);
	if (key.startsWith('w-'))
		return (await getLiveWeeklyReview(ownerId, id as IsoDate, deps)) !== null;
	if (!key.startsWith('c-') || !isUuid(id)) return false;
	return (await createReviewsRepository(resolve(deps).db).cycleReview(ownerId, id)) !== null;
}

/** The owner's live review of a week, or null. */
export async function getLiveWeeklyReview(
	ownerId: string,
	weekStartsOn: IsoDate,
	deps: ReviewDeps = {}
): Promise<StoredWeeklyReview | null> {
	if (parseIsoDate(weekStartsOn) === null) return null;
	const row = await createReviewsRepository(resolve(deps).db).liveWeeklyReview(
		ownerId,
		weekStartsOn
	);
	return row && weekly(row);
}

/** The owner's live review of a program's block, or null. */
export async function getLiveCycleReview(
	ownerId: string,
	programId: string,
	blockLineageId: string,
	deps: ReviewDeps = {}
): Promise<StoredCycleReview | null> {
	if (!isUuid(programId) || !isUuid(blockLineageId)) return null;
	const r = createReviewsRepository(resolve(deps).db);
	const row = await r.liveCycleReview(ownerId, programId, blockLineageId);
	return row && cycle(row);
}

/** Why a write to `kind` review `id` changed nothing: it is gone, superseded or already set. */
async function refusal(
	db: Executor,
	ownerId: string,
	kind: ReviewKind,
	id: string,
	field?: ReviewSetOnceError['field']
): Promise<Error> {
	const r = createReviewsRepository(db);
	const row = isUuid(id)
		? kind === 'weekly'
			? await r.weeklyReview(ownerId, id)
			: await r.cycleReview(ownerId, id)
		: null;
	if (!row) return new ReviewNotFoundError();
	if (row.supersededAt) return new ReviewSupersededError();
	if (field === 'nextVersion' && (row as CycleReviewRow).nextVersionId === null) {
		return new ReviewNotFoundError('program version');
	}
	return field ? new ReviewSetOnceError(field) : new ReviewSupersededError();
}

/** Replace the owner's live weekly review `id` with its next revision; both rows are kept. */
export async function supersedeWeeklyReview(
	ownerId: string,
	id: string,
	values: WeeklyRevision,
	deps: ReviewDeps = {}
): Promise<StoredWeeklyReview> {
	const { db, now } = resolve(deps);
	const row = isUuid(id)
		? await createReviewsRepository(db).supersedeWeekly(ownerId, id, values, now())
		: null;
	if (!row) throw await refusal(db, ownerId, 'weekly', id);
	return weekly(row);
}

/** Replace the owner's live cycle review `id` with its next revision; both rows are kept. */
export async function supersedeCycleReview(
	ownerId: string,
	id: string,
	values: CycleRevision,
	deps: ReviewDeps = {}
): Promise<StoredCycleReview> {
	const { db, now } = resolve(deps);
	const row = isUuid(id)
		? await createReviewsRepository(db).supersedeCycle(ownerId, id, values, now())
		: null;
	if (!row) throw await refusal(db, ownerId, 'cycle', id);
	return cycle(row);
}

/** Record the write-up a coach run produced, once. */
export async function setNarrative(
	ownerId: string,
	kind: ReviewKind,
	id: string,
	write: { narrative: string; runId: string; threadId: string },
	deps: ReviewDeps = {}
): Promise<void> {
	const { db, now } = resolve(deps);
	const r = createReviewsRepository(db);
	const done = isUuid(id) && (await r.setNarrative(kind, ownerId, id, { ...write, at: now() }));
	if (!done) throw await refusal(db, ownerId, kind, id, 'narrative');
}

/** Link the owner's proposal to the review, once. */
export async function linkProposal(
	ownerId: string,
	kind: ReviewKind,
	id: string,
	proposalId: string,
	deps: ReviewDeps = {}
): Promise<void> {
	const { db, now } = resolve(deps);
	const own =
		isUuid(proposalId) && (await createCoachProposalsRepository(db).proposal(ownerId, proposalId));
	if (!own) throw new ReviewNotFoundError('proposal');
	const r = createReviewsRepository(db);
	const done = isUuid(id) && (await r.linkProposal(kind, ownerId, id, proposalId, now()));
	if (!done) throw await refusal(db, ownerId, kind, id, 'proposal');
}

/** Name the version of the reviewed program that planned the next block, once. */
export async function setNextVersion(
	ownerId: string,
	id: string,
	versionId: string,
	deps: ReviewDeps = {}
): Promise<void> {
	const { db, now } = resolve(deps);
	const r = createReviewsRepository(db);
	const done =
		isUuid(id) && isUuid(versionId) && (await r.setNextVersion(ownerId, id, versionId, now()));
	if (!done) throw await refusal(db, ownerId, 'cycle', id, 'nextVersion');
}

export interface ReviewListItem {
	kind: ReviewKind;
	id: string;
	startsOn: IsoDate | null;
	endsOn: IsoDate | null;
	revision: number;
	summary: string;
	/** Written before M6 (or by another release): only the summary can be shown. */
	legacy: boolean;
}

function checkKeyset(before: ReviewsKeyset): void {
	if (before.weekly !== undefined && parseIsoDate(before.weekly) === null) {
		throw new ReviewInputError('before', 'An older page starts from a review date');
	}
	const c = before.cycle;
	if (c && (!isUuid(c.id) || (c.endsOn !== null && parseIsoDate(c.endsOn) === null))) {
		throw new ReviewInputError('before', 'An older page starts from a review');
	}
}

/**
 * A page of the owner's live reviews, weekly and cycle merged, newest period first. `next`
 * continues it from where each kind stopped (null at the end).
 */
export async function listReviews(
	ownerId: string,
	{ before = {}, limit = REVIEWS_PAGE.default }: { before?: ReviewsKeyset; limit?: number } = {},
	deps: ReviewDeps = {}
): Promise<{ items: ReviewListItem[]; next: ReviewsKeyset | null }> {
	if (!Number.isInteger(limit) || limit < 1 || limit > REVIEWS_PAGE.max) {
		throw new ReviewInputError('limit', `A page holds 1 to ${REVIEWS_PAGE.max} reviews`);
	}
	checkKeyset(before);
	const rows = await createReviewsRepository(resolve(deps).db).reviewsPage(ownerId, {
		before,
		limit: limit + 1
	});
	const items = rows.slice(0, limit).map((row) => ({
		kind: row.kind,
		id: row.id,
		startsOn: row.startsOn,
		endsOn: row.endsOn,
		revision: row.revision,
		summary: row.summary,
		legacy:
			row.snapshotVersion !== (row.kind === 'weekly' ? SNAPSHOT_VERSION : CYCLE_SNAPSHOT_VERSION)
	}));
	if (rows.length <= limit) return { items, next: null };
	const next: ReviewsKeyset = { ...before };
	for (const item of items) {
		if (item.kind === 'weekly') next.weekly = item.startsOn!;
		else next.cycle = { endsOn: item.endsOn, id: item.id };
	}
	return { items, next };
}

/** The newest revision of the review's proposal (null with none): the one its decision is on. */
export async function proposalHead(
	ownerId: string,
	review: Pick<StoredReview, 'proposalId'>,
	deps: ReviewDeps = {}
): Promise<ProposalHeadRow | null> {
	if (review.proposalId === null) return null;
	return createReviewsRepository(resolve(deps).db).proposalHead(ownerId, review.proposalId);
}

/** The decision a chain's head records. */
export function decisionOf(head: ProposalHeadRow | null): DecisionState {
	if (head === null) return { state: 'none' };
	const proposalId = head.id;
	switch (head.status) {
		case 'proposed':
			return { state: 'undecided', proposalId };
		case 'accepted':
			return { state: 'accepted_waiting', proposalId };
		case 'rejected':
			return { state: 'rejected', proposalId };
		case 'applied':
			return {
				state: 'applied',
				proposalId,
				versionId: head.appliedVersionId,
				versionNumber: head.appliedVersionNumber
			};
		case 'superseded':
			if (head.supersededReason === PARTLY_PAST_REASON && head.kind === 'replan')
				return { state: 'late', proposalId };
			return head.supersededReason === PARTLY_PAST_REASON
				? { state: 'partly_past', proposalId }
				: { state: 'superseded', proposalId, reason: head.supersededReason ?? 'unknown' };
	}
}

/** What the owner decided on the review's proposal, always from its chain's head. */
export async function decisionState(
	ownerId: string,
	review: Pick<StoredReview, 'proposalId'>,
	deps: ReviewDeps = {}
): Promise<DecisionState> {
	return decisionOf(await proposalHead(ownerId, review, deps));
}

/**
 * decisionState for several reviews in one query: each review's decision keyed by the proposal
 * it links, read from that proposal's chain head. A review with no proposal reads 'none'.
 */
export async function decisionStates(
	ownerId: string,
	reviews: readonly Pick<StoredReview, 'proposalId'>[],
	deps: ReviewDeps = {}
): Promise<Map<string, DecisionState>> {
	const ids = [...new Set(reviews.flatMap((r) => (r.proposalId === null ? [] : [r.proposalId])))];
	const heads = await createReviewsRepository(resolve(deps).db).proposalHeads(ownerId, ids);
	return new Map(heads.map(({ rootId, ...head }) => [rootId, decisionOf(head)]));
}

/** The display rows of the run that wrote the review's write-up (none before it is written). */
export async function narrativeBlocks(
	ownerId: string,
	review: Pick<StoredReview, 'narrativeRunId' | 'narrativeThreadId'>,
	deps: ReviewDeps = {}
) {
	const { narrativeRunId: runId, narrativeThreadId: threadId } = review;
	if (runId === null || threadId === null) return [];
	return createReviewsRepository(resolve(deps).db).narrativeMessages(ownerId, threadId, runId);
}

/** Whether the facts changed since the review was computed: today's digest differs from its own. */
export function stale(review: Pick<StoredReview, 'inputsDigest'>, digest: string): boolean {
	if (review.inputsDigest === null) return STALE_WITHOUT_DIGEST;
	return review.inputsDigest !== digest;
}
