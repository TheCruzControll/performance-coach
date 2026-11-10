/**
 * Deciding the next cycle (PRD §11; the M6 plan's next-cycle-apply): the owner plans the next
 * block from their cycle review, from the start they chose, as the preview showed it, or rejects
 * it. One transaction under the owner's review lock:
 * - The decision is on the head of the review's proposal chain (proposalHead). A review already
 *   decided returns its decision as it is, so a retry never plans twice.
 * - The posted fingerprint is the one the preview of that start showed on the head. One that no
 *   longer matches (the profile or the results changed) is a NextCycleConflictError 'profile',
 *   and nothing is written.
 * - Overrides make an owner revision of the head (revision_of, the review's provenance with
 *   modifiedBy 'owner'), held to the directives' bounds, and the revision is what is applied.
 *   `keep` keeps an exercise the rules would rotate: the revision carries the directives with it
 *   kept, which the preview and the plan then read.
 * - The block is planned by applyNextCycle as the program's next version; reject plans nothing.
 * Every query is awaited in turn, so the whole decision runs on one transaction.
 */
import { localDay } from '../../../domain/dates';
import {
	NEXT_BLOCK_STARTS,
	type NextBlockStart
} from '../../../domain/programming/next-block/dates';
import {
	clampOverrides,
	modifiableSubset,
	type CycleDirectives,
	type NextCycleSubset
} from '../../../domain/programming/review/directives';
import { getDb } from '../../db';
import { createCoachProposalsRepository } from '../../db/repositories/coach-proposals';
import { createReviewsRepository } from '../../db/repositories/reviews';
import { applyNextCycle, NextCycleConflictError } from '../coach/apply/next-cycle';
import { createProposal, rejectProposal, type RulesProvenance } from '../coach/proposals';
import { getAthleteProfile } from '../profile/index';
import { plannedNextBlock, type CycleEvidence } from './cycle';
import {
	decisionOf,
	getCycleReview,
	proposalHead,
	ReviewInputError,
	ReviewSupersededError,
	type ReviewDeps
} from './store';

export const NO_NEXT_BLOCK = 'This review has no next block to decide';
/** The reason a kept exercise's directive gives once the owner keeps what the rules rotated. */
export const OWNER_KEPT = 'Kept: your choice';

/** What the owner may change before the block is planned; `keep` names rotated exercises by id. */
export type NextCycleOverrides = Partial<Omit<NextCycleSubset, 'fromBlockLineage'>> & {
	keep?: readonly string[];
};

export interface DecideNextCycle {
	/** The fingerprint of the preview the owner saw for `start`. */
	fingerprint?: string;
	start?: NextBlockStart;
	overrides?: NextCycleOverrides;
	/** Plan nothing: the head is rejected with `note`. */
	reject?: boolean;
	note?: string | null;
}

export type NextCycleDecision =
	| {
			outcome: 'applied';
			proposalId: string;
			versionId: string | null;
			versionNumber: number | null;
	  }
	| { outcome: 'rejected'; proposalId: string }
	| { outcome: 'superseded'; proposalId: string; reason: string };

/** The directives with `keep` moved from rotate to keep; one the rules do not rotate is refused. */
function kept(directives: CycleDirectives, keep: readonly string[]): CycleDirectives {
	const rotated = new Set(directives.rotate.map((r) => r.exercise));
	if (keep.some((id) => !rotated.has(id)))
		throw new ReviewInputError('overrides.keep', 'Keep an exercise this review rotates');
	const kept = new Set(keep);
	return {
		...directives,
		keep: [
			...directives.keep,
			...directives.rotate.flatMap((r) =>
				kept.has(r.exercise) ? [{ ...r, reason: OWNER_KEPT }] : []
			)
		],
		rotate: directives.rotate.filter((r) => !kept.has(r.exercise))
	};
}

/**
 * Decide on the owner's cycle review `reviewId`: plan its next block from `start` as the
 * preview with `fingerprint` showed it, with any overrides, or reject it.
 */
export async function decideNextCycle(
	ownerId: string,
	reviewId: string,
	input: DecideNextCycle,
	deps: ReviewDeps = {}
): Promise<NextCycleDecision> {
	const db = deps.db ?? getDb();
	const now = deps.now ?? (() => new Date());
	return db.transaction(async (tx) => {
		const inTx = { db: tx, now };
		await createReviewsRepository(tx).lock(ownerId);
		const review = await getCycleReview(ownerId, reviewId, inTx);
		if (review.supersededAt) throw new ReviewSupersededError();
		const head = await proposalHead(ownerId, review, inTx);
		const decision = decisionOf(head);
		switch (decision.state) {
			case 'applied': {
				const { proposalId, versionId, versionNumber } = decision;
				return { outcome: 'applied', proposalId, versionId, versionNumber };
			}
			case 'rejected':
				return { outcome: 'rejected', proposalId: decision.proposalId };
			case 'superseded':
				return { outcome: 'superseded', proposalId: decision.proposalId, reason: decision.reason };
			case 'undecided':
				break;
			default:
				throw new ReviewInputError('start', NO_NEXT_BLOCK);
		}
		if (input.reject) {
			await rejectProposal(ownerId, head!.id, { reason: input.note ?? null }, inTx);
			return { outcome: 'rejected', proposalId: head!.id };
		}
		const { start, fingerprint } = input;
		if (!start || !NEXT_BLOCK_STARTS.includes(start))
			throw new ReviewInputError('start', 'Choose this week or next Monday');
		if (typeof fingerprint !== 'string') throw new ReviewInputError('fingerprint', 'Preview again');

		const { timeZone } = await getAthleteProfile(ownerId, inTx);
		const today = localDay(now(), timeZone);
		const shown = await plannedNextBlock(ownerId, review, { headId: head!.id, start, today }, inTx);
		if (shown.preview.fingerprint !== fingerprint) throw new NextCycleConflictError('profile');

		let target = head!.id;
		let planned = shown;
		if (input.overrides) {
			const row = (await createCoachProposalsRepository(tx).lockProposal(ownerId, head!.id))!;
			const { source, ...evidence } = row.evidence as unknown as CycleEvidence & {
				source: RulesProvenance;
			};
			const { keep = [], ...fields } = input.overrides;
			const directives = keep.length ? kept(evidence.directives, keep) : evidence.directives;
			// A keep changes how many exercises the rules' focus says are kept, unless the owner
			// wrote their own focus; otherwise the head's focus (a folded coach's) stays.
			const asked = { ...(row.payload as unknown as NextCycleSubset), ...fields };
			if (fields.focus === undefined && keep.length)
				asked.focus = modifiableSubset(directives).focus;
			const { subset, clamps } = clampOverrides(asked, directives);
			const { proposal } = await createProposal(
				ownerId,
				{
					proposal: {
						kind: 'next_cycle',
						title: row.title,
						rationale: row.rationale,
						payload: subset
					},
					revises: row.id,
					provenance: { ...source, modifiedBy: 'owner' },
					evidence: {
						...evidence,
						directives,
						overrides: { ...evidence.overrides, ...fields },
						clamps: [...evidence.clamps, ...clamps]
					}
				},
				inTx
			);
			target = proposal.id;
			if (target !== head!.id)
				planned = await plannedNextBlock(ownerId, review, { headId: target, start, today }, inTx);
		}
		// Every revision of the review's proposal is the owner's (a fold or an override).
		const createdBy = target === review.proposalId ? 'rules' : 'owner';
		const stored = await applyNextCycle(
			ownerId,
			{ review, proposalId: target, planned, createdBy },
			inTx
		);
		return {
			outcome: 'applied',
			proposalId: target,
			versionId: stored.versionId,
			versionNumber: stored.number
		};
	});
}
