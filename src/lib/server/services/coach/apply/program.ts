/**
 * Applying program proposals (the M5 plan's apply-program-proposals): a program_adjustment or a
 * workout_update is every one of its ops as one new version of the active program, through M3's
 * edits (applyProgramEdits, source 'coach'), with one coach decision per op whose 'why' is the
 * proposal's rationale and whose evidence names the proposal. acceptProposal then stores the
 * version as applied_version_id and closes the proposal, in the same transaction.
 *
 * - The version is made on the base the proposal was drafted on. If another version became
 *   current meanwhile (an owner edit racing the accept), it is superseded ('program_changed') and
 *   nothing is written.
 * - An op its edit refuses at accept (a session done since, two ops at odds) is a
 *   ProposalRefusedError at payload.ops.n: nothing is written and the proposal stays proposed.
 * - A workout_update is refused once its workout has started (WORKOUT_STARTED): a workout in
 *   progress or completed against its session, which a session substitution changes instead.
 * - A weekly review's proposal (evidence.source) is decided by the rules, or by the owner when
 *   they modified it: each decision keeps its edit's why, with the op's reason, the version reads
 *   'Next week from your review of 2 Nov', and a review_applied decision names the review.
 *   acceptProposal runs this whether the review or M5's inbox accepts it, so both read the same.
 * - new_program and next_cycle are ./program-create.ts's.
 */
import type { IsoDate } from '../../../../domain/calendar';
import type { ProgramOp, Proposal } from '../../../../domain/coach/proposals';
import { render, TEMPLATES } from '../../../../domain/programming/decisions';
import { createCoachProposalsRepository } from '../../../db/repositories/coach-proposals';
import { createProgramsRepository } from '../../../db/repositories/programs';
import { applyProgramEdits, type ProgramEditBatch } from '../../programs/batch';
import { ProgramConflictError, TrainingInputError } from '../../training/shared';
import { listActiveWorkouts } from '../../workouts/canonical';
import { ProposalRefusedError, type RulesProvenance } from '../proposals';
import type { ApplyInput, ApplyOutcome, Appliers } from './types';

/** Why a workout_update is refused at accept once its session's workout has begun. */
export const WORKOUT_STARTED = 'This workout has already started';

const PROGRAM_CHANGED: ApplyOutcome = { status: 'superseded', reason: 'program_changed' };

/** The review_applied decision's rule. */
export const REVIEW_APPLIED_RULE = 'review.weekly';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2 Nov'. */
const dayMonth = (date: IsoDate) =>
	`${Number(date.slice(8))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** How a weekly review's proposal applies: who decided, the version's summary, review_applied. */
function fromReview(
	source: unknown,
	ops: readonly ProgramOp[]
): Partial<Pick<ProgramEditBatch, 'title' | 'decidedBy' | 'decision'>> {
	const review = source as Partial<RulesProvenance> | null;
	if (review?.kind !== 'weekly_review' || !review.weekStartsOn || !review.reviewId) return {};
	const decidedBy = review.modifiedBy === 'owner' ? 'owner' : 'rules';
	const trimmed = review.trimmed ?? 0;
	const facts = {
		who: decidedBy === 'owner' ? 'You' : 'The programming rules',
		changes: count(ops.length, 'change', 'changes'),
		review: `weekly review of ${dayMonth(review.weekStartsOn)}`,
		reason: trimmed
			? `${count(trimmed, 'change was', 'changes were')} for sessions already past, so left out.`
			: 'Each change says why in its own decision.'
	};
	const template = TEMPLATES.review_applied;
	return {
		title: `Next week from your review of ${dayMonth(review.weekStartsOn)}`,
		decidedBy,
		decision: {
			kind: 'review_applied',
			ruleKey: REVIEW_APPLIED_RULE,
			summary: render(template.summary, facts, 'review_applied'),
			why: render(template.why, facts, 'review_applied'),
			affected: [...new Set(ops.map((op) => op.sessionLineage))],
			evidence: { reviewId: review.reviewId, revision: review.revision ?? 1, trimmed }
		}
	};
}

/**
 * Whether a workout has begun on `lineage`: one in progress (among the newest the owner has, as
 * Today lists them), or one completed.
 */
async function workoutStarted(ownerId: string, lineage: string, { db }: ApplyInput['deps']) {
	const { workouts } = await listActiveWorkouts(ownerId, { db });
	if (workouts.some((w) => w.plannedLineage === lineage)) return true;
	const done = await createProgramsRepository(db).completedLineages(ownerId, [lineage]);
	return done.has(lineage);
}

/** Apply the proposal's ops as one version on its base. */
async function applyOps(
	input: Omit<ApplyInput, 'proposal'>,
	proposal: Extract<Proposal, { kind: 'program_adjustment' | 'workout_update' }>
): Promise<ApplyOutcome> {
	const { ownerId, proposalId, baseVersionId, today, deps } = input;
	const current = await createProgramsRepository(deps.db).currentProgram(ownerId);
	if (!current || current.version.id !== baseVersionId) return PROGRAM_CHANGED;
	const { title, rationale, payload } = proposal;
	const row = await createCoachProposalsRepository(deps.db).proposal(ownerId, proposalId);
	try {
		const version = await applyProgramEdits(
			ownerId,
			{
				baseVersion: current.version.number,
				today,
				ops: payload.ops,
				title,
				rationale,
				evidence: { proposalId },
				...fromReview(row?.source, payload.ops)
			},
			{ db: deps.db, now: deps.now }
		);
		return { status: 'applied', appliedVersionId: version.versionId };
	} catch (error) {
		if (error instanceof ProgramConflictError) return PROGRAM_CHANGED;
		if (error instanceof TrainingInputError) {
			throw new ProposalRefusedError(
				Object.fromEntries(Object.entries(error.errors).map(([k, m]) => [`payload.${k}`, m]))
			);
		}
		throw error;
	}
}

export const PROGRAM_APPLIERS: Pick<Appliers, 'program_adjustment' | 'workout_update'> = {
	program_adjustment: (input) => applyOps(input, input.proposal),

	async workout_update(input) {
		// proposal-rules holds every op of a workout_update to one session.
		const lineage = input.proposal.payload.ops[0]!.sessionLineage;
		if (await workoutStarted(input.ownerId, lineage, input.deps)) {
			throw new ProposalRefusedError({ 'payload.ops.0.sessionLineage': WORKOUT_STARTED });
		}
		return applyOps(input, input.proposal);
	}
};
