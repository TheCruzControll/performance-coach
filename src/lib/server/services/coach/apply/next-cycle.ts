/**
 * Applying a next_cycle (PRD §11; the M6 plan's next-cycle-apply). A next block needs a start
 * choice and a fresh preview, so only the cycle review plans one; every path M5's inbox can take
 * has its own outcome, all inside the accept transaction:
 * - The review's own proposal (evidence.source names a cycle review), or an owner revision of
 *   it: acceptProposal refuses it (refuseReviewNextCycle) before its base version is checked, a
 *   NextCycleConflictError 'choose_start' with the review's link, so nothing is applied. The
 *   review applies it through decideNextCycle, which passes the start and the fingerprint
 *   (applyNextCycle below).
 * - A coach next_cycle for a block with no live review: accepted, and it waits for the review
 *   (NEXT_CYCLE_AWAITS), which folds it in when it is created (services/reviews/cycle.ts).
 * - One for a block whose review is undecided: its fields go into an owner revision of the
 *   review's head, held to the directives' bounds (clampOverrides), and it is superseded as
 *   folded_into_review. The revision's evidence.folded names it, and its source the review.
 * - One for a block whose review is decided: superseded as cycle_planned once the next block is
 *   planned, else as folded_into_review. Either way the outcome carries the review's href.
 * applyNextCycle stores the planned block as the program's next version (planBlock), names it
 * as the review's next version, applies the proposal and supersedes every other open next_cycle
 * for that block as cycle_planned. Every query is awaited in turn on the caller's transaction.
 */
import { CATALOGUE } from '../../../../domain/exercises/index';
import { NEXT_CYCLE_AWAITS } from '../../../../domain/coach/proposals';
import type { SupersededReason } from '../../../../domain/coach/vocabulary';
import { GENERATOR_ID } from '../../../../domain/programming/next-block/generate';
import { catalogueDigest } from '../../../../domain/programming/random';
import {
	clampOverrides,
	type NextCycleSubset
} from '../../../../domain/programming/review/directives';
import type { Decider } from '../../../../domain/training/vocabulary';
import { createCoachProposalsRepository } from '../../../db/repositories/coach-proposals';
import { createReviewsRepository } from '../../../db/repositories/reviews';
import { listCustomExercises } from '../../exercises/index';
import { APPEND, planBlock } from '../../programs/next-block';
import type { CycleEvidence, PlannedNextBlock } from '../../reviews/cycle';
import {
	decisionOf,
	getLiveCycleReview,
	proposalHead,
	setNextVersion,
	type StoredCycleReview
} from '../../reviews/store';
import { ConflictError } from '../../training/shared';
import { createProposal, type RulesProvenance } from '../proposals';
import type { ResolvedCoachDeps } from '../shared';
import type { ApplyInput, ApplyOutcome, Appliers } from './types';

/** What M5's card says instead of Accept for the review's own next_cycle. */
export const CHOOSE_START = 'Choose when it starts in your cycle review';

/** The most open proposals read when closing a planned block's other next_cycle proposals. */
export const OPEN_SCAN = 50;

/** The cycle review page of `reviewId` (proposals.ts's origin href). */
export const cycleReviewHref = (reviewId: string) => `/progress/reviews/c-${reviewId}`;

export type NextCycleConflictReason = 'choose_start' | 'profile';

const CONFLICT_MESSAGE: Readonly<Record<NextCycleConflictReason, string>> = {
	choose_start: CHOOSE_START,
	profile: 'the profile or the results changed since the preview'
};

/**
 * Nothing was applied: the review's next_cycle needs a start chosen in the review (href), or the
 * preview the owner saw is no longer what would be planned ('profile').
 */
export class NextCycleConflictError extends ConflictError<NextCycleConflictReason> {
	readonly href: string | null;

	constructor(reason: NextCycleConflictReason, href: string | null = null) {
		super(reason, CONFLICT_MESSAGE[reason]);
		this.name = 'NextCycleConflictError';
		this.href = href;
	}
}

type ReviewEvidence = CycleEvidence & { source: RulesProvenance };

/** The review a proposal's evidence.source names, when it is a cycle review's. */
function cycleSource(evidence: unknown): RulesProvenance | null {
	const source = (evidence as { source?: Partial<RulesProvenance> } | null)?.source;
	return source?.kind === 'cycle_review' && typeof source.reviewId === 'string'
		? (source as RulesProvenance)
		: null;
}

/** A next_cycle accepted from M5's inbox that the review at its evidence.source plans. */
export function refuseReviewNextCycle(evidence: unknown): void {
	const source = cycleSource(evidence);
	if (source) throw new NextCycleConflictError('choose_start', cycleReviewHref(source.reviewId));
}

/** A coach's next_cycle for the block `review` covers, folded in or closed as its state says. */
async function intoReview(
	ownerId: string,
	proposalId: string,
	payload: NextCycleSubset,
	review: StoredCycleReview,
	deps: ResolvedCoachDeps
): Promise<ApplyOutcome> {
	const superseded = (reason: SupersededReason): ApplyOutcome => {
		return { status: 'superseded', reason, href: cycleReviewHref(review.id) };
	};
	const head = await proposalHead(ownerId, review, deps);
	const state = decisionOf(head).state;
	if (review.nextVersionId !== null || state === 'applied') return superseded('cycle_planned');
	if (state !== 'undecided') return superseded('folded_into_review');
	const row = (await createCoachProposalsRepository(deps.db).lockProposal(ownerId, head!.id))!;
	const { source, ...evidence } = row.evidence as unknown as ReviewEvidence;
	const asked = { ...(row.payload as unknown as NextCycleSubset), ...payload };
	const { subset, clamps } = clampOverrides(asked, evidence.directives);
	await createProposal(
		ownerId,
		{
			proposal: { kind: 'next_cycle', title: row.title, rationale: row.rationale, payload: subset },
			revises: row.id,
			provenance: { ...source, modifiedBy: 'owner' },
			evidence: {
				...evidence,
				overrides: { ...evidence.overrides, ...payload },
				clamps,
				folded: [...evidence.folded, proposalId]
			}
		},
		deps
	);
	return superseded('folded_into_review');
}

export const NEXT_CYCLE_APPLIERS: Pick<Appliers, 'next_cycle'> = {
	async next_cycle({ ownerId, proposalId, proposal, programId, deps }: ApplyInput<'next_cycle'>) {
		const { payload } = proposal;
		if (programId === null) return { status: 'accepted', awaits: NEXT_CYCLE_AWAITS };
		// The owner's review lock, as creating or deciding a review takes it: a fold never races one.
		await createReviewsRepository(deps.db).lock(ownerId);
		const review = await getLiveCycleReview(ownerId, programId, payload.fromBlockLineage, deps);
		if (!review) return { status: 'accepted', awaits: NEXT_CYCLE_AWAITS };
		return intoReview(ownerId, proposalId, payload, review, deps);
	}
};

/** Close every other open next_cycle for the planned block as cycle_planned. */
async function closeOthers(
	ownerId: string,
	blockLineage: string,
	appliedId: string,
	deps: ResolvedCoachDeps
): Promise<void> {
	const repo = createCoachProposalsRepository(deps.db);
	const open = await repo.proposalPage(ownerId, { status: 'proposed', limit: OPEN_SCAN });
	for (const p of open) {
		if (p.kind !== 'next_cycle' || p.id === appliedId) continue;
		const row = (await repo.lockProposal(ownerId, p.id))!;
		const payload = row.payload as unknown as NextCycleSubset;
		if (row.status !== 'proposed' || payload.fromBlockLineage !== blockLineage) continue;
		const at = deps.now();
		await repo.decide(ownerId, row.id, {
			...{ status: 'superseded', supersededReason: 'cycle_planned' },
			...{ closedAt: at, updatedAt: at }
		});
	}
}

export interface NextCycleApply {
	review: StoredCycleReview;
	/** The head of the review's proposal chain, which is applied. */
	proposalId: string;
	/** The block from the start the owner chose, as plannedNextBlock gives it. */
	planned: PlannedNextBlock;
	createdBy: Decider;
}

/**
 * Store the review's next block as the program's next version, exactly once: the review names
 * it as its next version (set once), the proposal is applied with it, and the block's other open
 * next_cycle proposals are superseded as cycle_planned.
 */
export async function applyNextCycle(
	ownerId: string,
	{ review, proposalId, planned, createdBy }: NextCycleApply,
	deps: ResolvedCoachDeps
): Promise<{ versionId: string; number: number }> {
	const { preview } = planned;
	const customs = await listCustomExercises(ownerId, { db: deps.db });
	const stored = await planBlock(
		ownerId,
		{
			baseVersionNumber: planned.versionNumber,
			blockLineage: planned.outlineLineage ?? APPEND,
			...(preview.bridge && { bridge: preview.bridge }),
			block: preview.block,
			shifted: preview.dates.shifted.map((d, i) => ({
				lineage: planned.shiftedLineages[i]!,
				startsOn: d.startsOn,
				endsOn: d.endsOn
			})),
			firstPlannedDay: preview.dates.firstPlannedDay,
			decisions: preview.decisions,
			createdBy,
			summary: `Next block: ${preview.block.name}`,
			origin: {
				generator: GENERATOR_ID,
				fingerprint: preview.fingerprint,
				digest: catalogueDigest(CATALOGUE, customs),
				snapshot: planned.input as unknown as Record<string, unknown>
			}
		},
		deps
	);
	await setNextVersion(ownerId, review.id, stored.versionId, deps);
	const at = deps.now();
	await createCoachProposalsRepository(deps.db).decide(ownerId, proposalId, {
		...{ status: 'applied', appliedVersionId: stored.versionId },
		...{ closedAt: at, updatedAt: at }
	});
	await closeOthers(ownerId, review.blockLineageId, proposalId, deps);
	return { versionId: stored.versionId, number: stored.number };
}
