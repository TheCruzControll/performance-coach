/**
 * Deciding next week (PRD §11; the M6 plan's next-week-decide): the owner takes each of a weekly
 * review's next-week changes as proposed, at its half step, or leaves it out, on any day of next
 * week, and 'Generate next week' applies exactly the chosen changes still ahead as one version.
 *
 * - The decision is on the head of the review's proposal chain (proposalHead), undecided or
 *   partly past (superseded as sessions_passed by an accept from M5's inbox).
 * - The chosen ops are split with opsStillAhead, as acceptProposal splits them: a change whose
 *   session has passed or started is dropped and counted in `passed`.
 * - Everything as proposed and still ahead: the head is accepted as it is.
 * - Anything left out, at a half step or no longer ahead: an owner revision of the head
 *   (createProposal, revision_of the head, the review's provenance with modifiedBy 'owner' when
 *   the owner changed a choice and trimmed: n) holds only the chosen ops still ahead, and is
 *   accepted. M5's applier writes each change's why and a review_applied decision.
 * - Nothing chosen: the head is rejected with the owner's note (a partly past head, already
 *   closed, through a revision of what is still ahead).
 * - Nothing chosen is still ahead: nothing is written, and the result says TOO_LATE.
 * - A review already decided returns its decision as it is, so a retry never applies twice; the
 *   owner's review lock serialises two at once. A head whose program has moved on is superseded
 *   (program_changed) by acceptProposal, and nothing is applied.
 * - nextWeekOffers lists the head's changes for the review screen, each split the same way.
 * - M7: a head of kind replan (the review's reactive deload) is taken or kept whole: Accept
 *   (`accept: true`) is acceptProposal, whose applier re-checks the sessions still ahead (late:
 *   superseded as sessions_passed); Keep is rejectProposal with the note. Items and half steps do
 *   not apply to it, and a request carrying them is refused; `accept` is refused on a head of
 *   changes, which are chosen one by one. The result keeps M6's shape, with passed 0: a deload
 *   drops nothing the owner chose, it eases whatever is still ahead.
 * Every query is awaited in turn, so the whole decision runs on one transaction.
 */
import type { IsoDate } from '../../../domain/calendar';
import type { ProgramOp } from '../../../domain/coach/proposals';
import { localDay } from '../../../domain/dates';
import { getDb } from '../../db';
import { createCoachProposalsRepository } from '../../db/repositories/coach-proposals';
import { createProgramsRepository } from '../../db/repositories/programs';
import { createReviewsRepository } from '../../db/repositories/reviews';
import {
	acceptProposal,
	createProposal,
	opsStillAhead,
	rejectProposal,
	type ProposalView,
	type RulesProvenance
} from '../coach/proposals';
import { getAthleteProfile } from '../profile/index';
import {
	decisionOf,
	getWeeklyReview,
	proposalHead,
	ReviewInputError,
	ReviewNotFoundError,
	ReviewSupersededError,
	type ReviewDeps
} from './store';

/** What the review says when every chosen change was for a session already past. */
export const TOO_LATE = 'Too late to change next week';
export const NOTHING_TO_DECIDE = 'This review proposes no changes for next week';
/** A deload is taken or kept whole: it has no changes to choose among. */
export const WHOLE_ONLY = 'A deload is taken or kept as a whole';
/** `accept` takes a deload; a review's changes are chosen one by one. */
export const ONE_BY_ONE = 'Choose the changes one by one';

/** A change taken as proposed, or at its half step; a change not listed is left out. */
export interface NextWeekItem {
	id: string;
	choice: 'proposed' | 'half_step';
}

export interface DecideNextWeek {
	items: readonly NextWeekItem[];
	/** M7: take a replan head (a deload) whole; without it, a replan head is kept (rejected). */
	accept?: boolean;
	/** The owner's reason when nothing is taken: stored with the rejection. */
	note?: string | null;
}

export type NextWeekDecision =
	| {
			outcome: 'applied';
			proposalId: string;
			versionId: string | null;
			versionNumber: number | null;
			/** Chosen changes dropped because their sessions had passed. */
			passed: number;
	  }
	| { outcome: 'rejected'; proposalId: string }
	| { outcome: 'too_late'; passed: number; words: typeof TOO_LATE }
	| { outcome: 'superseded'; proposalId: string; reason: string };

/** One change the head offers: its op, its half step and its stored evidence. */
interface Offered {
	id: string;
	op: ProgramOp;
	halfStep: ProgramOp | null;
	adjustment: Record<string, unknown> | null;
}
type Chosen = Offered & { choice: NextWeekItem['choice'] };

type ProposalRow = NonNullable<
	Awaited<ReturnType<ReturnType<typeof createCoachProposalsRepository>['lockProposal']>>
>;

/** The head's changes: payload.ops, paired by place with the review's evidence.adjustments. */
function offeredOf(row: ProposalRow): Offered[] {
	if (row.kind === 'replan') return [];
	const { ops } = row.payload as { ops: ProgramOp[] };
	const evidence = row.evidence as { adjustments?: Record<string, unknown>[] } | null;
	const adjustments = evidence?.adjustments?.length === ops.length ? evidence.adjustments : [];
	return ops.map((op, i) => {
		const adjustment = adjustments[i] ?? null;
		return {
			id: typeof adjustment?.id === 'string' ? adjustment.id : `op:${i}`,
			op,
			halfStep: (adjustment?.halfStep as ProgramOp | null | undefined) ?? null,
			adjustment
		};
	});
}

/** The owner's choices among the offered changes, in the head's order; refused if unknown. */
function choose(offered: readonly Offered[], items: readonly NextWeekItem[]): Chosen[] {
	const byId = new Map(items.map((item) => [item.id, item.choice]));
	if (byId.size !== items.length) throw new ReviewInputError('items', 'Choose each change once');
	for (const [id, choice] of byId) {
		const change = offered.find((o) => o.id === id);
		if (!change || (choice !== 'proposed' && choice !== 'half_step'))
			throw new ReviewInputError('items', 'That change is not in this review');
		if (choice === 'half_step' && !change.halfStep)
			throw new ReviewInputError('items', 'That change has no half step');
	}
	return offered.flatMap((o) => (byId.has(o.id) ? [{ ...o, choice: byId.get(o.id)! }] : []));
}

const superseded = (proposal: ProposalView): NextWeekDecision => ({
	outcome: 'superseded',
	proposalId: proposal.id,
	reason: proposal.supersededReason ?? proposal.status
});

/**
 * Decide on the owner's weekly review `reviewId`: apply the chosen changes still ahead as one new
 * version, reject them all with the note, or say it is too late.
 */
export async function decideNextWeek(
	ownerId: string,
	reviewId: string,
	input: DecideNextWeek,
	deps: ReviewDeps = {}
): Promise<NextWeekDecision> {
	const db = deps.db ?? getDb();
	const now = deps.now ?? (() => new Date());
	return db.transaction(async (tx) => {
		const inTx = { db: tx, now };
		await createReviewsRepository(tx).lock(ownerId);
		const review = await getWeeklyReview(ownerId, reviewId, inTx);
		if (review.supersededAt) throw new ReviewSupersededError();
		const head = await proposalHead(ownerId, review, inTx);
		const decision = decisionOf(head);
		if (!head || decision.state === 'accepted_waiting')
			throw new ReviewInputError('items', NOTHING_TO_DECIDE);
		const row = (await createCoachProposalsRepository(tx).lockProposal(ownerId, head.id))!;
		const source = (row.evidence as { source: RulesProvenance }).source;
		if (decision.state === 'applied') {
			const { versionId, versionNumber } = decision;
			const passed = source.trimmed ?? 0;
			return { outcome: 'applied', proposalId: head.id, versionId, versionNumber, passed };
		}
		if (decision.state === 'rejected') return { outcome: 'rejected', proposalId: head.id };
		if (decision.state === 'superseded')
			return { outcome: 'superseded', proposalId: head.id, reason: decision.reason };
		if (decision.state === 'late')
			return { outcome: 'superseded', proposalId: head.id, reason: 'sessions_passed' };
		const replan = row.kind === 'replan';
		if (replan && input.items.length) throw new ReviewInputError('items', WHOLE_ONLY);
		if (!replan && input.accept) throw new ReviewInputError('items', ONE_BY_ONE);

		// Undecided or partly past. A program edited since the review supersedes it.
		const current = await createProgramsRepository(tx).currentProgram(ownerId);
		if (current?.version.id !== row.baseVersionId) {
			if (row.status !== 'proposed')
				return { outcome: 'superseded', proposalId: row.id, reason: 'program_changed' };
			return superseded((await acceptProposal(ownerId, row.id, inTx)).proposal);
		}
		if (replan) {
			if (!input.accept) {
				await rejectProposal(ownerId, row.id, { reason: input.note ?? null }, inTx);
				return { outcome: 'rejected', proposalId: row.id };
			}
			const { proposal } = await acceptProposal(ownerId, row.id, inTx);
			if (proposal.status !== 'applied') return superseded(proposal);
			return {
				outcome: 'applied',
				proposalId: proposal.id,
				versionId: proposal.appliedVersion?.id ?? null,
				versionNumber: proposal.appliedVersion?.number ?? null,
				passed: 0
			};
		}
		const offered = offeredOf(row);
		const chosen = choose(offered, input.items);
		const { timeZone } = await getAthleteProfile(ownerId, inTx);
		const ahead = new Set(
			(await opsStillAhead(ownerId, offered, localDay(now(), timeZone), tx)).map((o) => o.id)
		);
		const kept = chosen.filter((c) => ahead.has(c.id));
		const passed = chosen.length - kept.length;

		/** The owner's revision of the head holding `changes`, the base of their decision. */
		const revise = async (changes: readonly Chosen[], trimmed: number) => {
			const total = trimmed + (source.trimmed ?? 0);
			const modified =
				changes.some((c) => c.choice === 'half_step') ||
				offered.some((o) => ahead.has(o.id) && !changes.some((c) => c.id === o.id));
			const { proposal } = await createProposal(
				ownerId,
				{
					proposal: {
						kind: 'program_adjustment',
						title: row.title,
						rationale: row.rationale,
						payload: {
							ops: changes.map((c) => (c.choice === 'half_step' ? c.halfStep! : c.op))
						}
					},
					revises: row.id,
					provenance: {
						...source,
						...(modified || source.modifiedBy ? { modifiedBy: 'owner' as const } : {}),
						...(total ? { trimmed: total } : {})
					},
					evidence: {
						adjustments: changes.map((c) => ({
							...c.adjustment,
							id: c.id,
							choice: c.choice,
							halfStep: c.choice === 'half_step' ? null : c.halfStep
						}))
					}
				},
				inTx
			);
			return proposal;
		};

		if (chosen.length === 0) {
			const note = { reason: input.note ?? null };
			if (row.status === 'proposed') {
				await rejectProposal(ownerId, row.id, note, inTx);
				return { outcome: 'rejected', proposalId: row.id };
			}
			// A partly past head is closed: what is still ahead is revised, then rejected.
			const rest = offered.filter((o) => ahead.has(o.id));
			if (!rest.length) return { outcome: 'too_late', passed: offered.length, words: TOO_LATE };
			const revision = await revise(
				rest.map((o) => ({ ...o, choice: 'proposed' as const })),
				offered.length - rest.length
			);
			await rejectProposal(ownerId, revision.id, note, inTx);
			return { outcome: 'rejected', proposalId: revision.id };
		}
		if (kept.length === 0) return { outcome: 'too_late', passed, words: TOO_LATE };

		const asProposed =
			row.status === 'proposed' &&
			kept.length === offered.length &&
			kept.every((c) => c.choice === 'proposed');
		const target = asProposed ? row.id : (await revise(kept, passed)).id;
		const { proposal } = await acceptProposal(ownerId, target, inTx);
		if (proposal.status !== 'applied') return superseded(proposal);
		return {
			outcome: 'applied',
			proposalId: proposal.id,
			versionId: proposal.appliedVersion?.id ?? null,
			versionNumber: proposal.appliedVersion?.number ?? null,
			passed
		};
	});
}

/** A change the review offers, as its screen lists it: still ahead today, or no longer. */
export interface NextWeekOffer {
	id: string;
	/** The day of the session it changes; null for a proposal stored without its evidence. */
	sessionDate: IsoDate | null;
	why: string | null;
	halfStep: ProgramOp | null;
	/** False once its session has passed or started: deciding drops it (opsStillAhead). */
	ahead: boolean;
}

/**
 * The changes proposal `proposalId` (a review's head) offers, in its order, each split as
 * decideNextWeek splits them on the owner's `today`, so the screen strikes through exactly the
 * changes a decision would drop.
 */
export async function nextWeekOffers(
	ownerId: string,
	proposalId: string,
	today: IsoDate,
	deps: ReviewDeps = {}
): Promise<NextWeekOffer[]> {
	const db = deps.db ?? getDb();
	// One transaction, the head locked as a decision locks it: the split is of this very row.
	const { offered, ahead } = await db.transaction(async (tx) => {
		const row = await createCoachProposalsRepository(tx).lockProposal(ownerId, proposalId);
		if (!row) throw new ReviewNotFoundError('proposal');
		const offered = offeredOf(row);
		return { offered, ahead: await opsStillAhead(ownerId, offered, today, tx) };
	});
	const still = new Set(ahead.map((o) => o.id));
	return offered.map((o) => ({
		id: o.id,
		sessionDate: (o.adjustment?.sessionDate as IsoDate | undefined) ?? null,
		why: (o.adjustment?.why as string | undefined) ?? null,
		halfStep: o.halfStep,
		ahead: still.has(o.id)
	}));
}
