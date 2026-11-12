/**
 * What a weekly review changed in a week (the M6 plan's train-review-notice), for Train's notice:
 * the newest version up to the one shown whose review_applied decision touched a session of the
 * week, who decided it, each of its changes with its why, and the review it came from.
 *
 * - M5's applier writes review_applied whichever revision of the review's proposal was applied:
 *   the rules' untouched proposal, the owner's modified one, or one trimmed of passed sessions.
 *   All three are found the same way, and only the changes that were applied are listed.
 * - A later edit of the week (a move, a skip) does not hide it: the week was still updated from
 *   the review, and History lists the edit after it.
 * - Everything is the owner's: another owner's program, version or review is never read.
 */
import type { IsoDate } from '../../../domain/calendar';
import type { Decider } from '../../../domain/training/vocabulary';
import { createProgramsRepository } from '../../db/repositories/programs';
import { createReviewsRepository } from '../../db/repositories/reviews';
import { isUuid } from '../ids';
import { resolveDeps, type TrainingDeps } from '../training/shared';

export interface WeekChanges {
	/** The version that applied the review. */
	version: { number: number; createdBy: Decider };
	/** The review_applied decision's why: who applied how many changes, and any left out. */
	applied: string;
	/** Each change it made, in the order written. */
	changes: { summary: string; why: string }[];
	/** The weekly review it came from, by its Monday; null if that review is gone. */
	review: { weekStartsOn: IsoDate } | null;
}

export interface WeekAtVersion {
	programId: string;
	/** The version shown; earlier versions are its history. */
	version: number;
	weekLineage: string;
}

export async function weekChanges(
	ownerId: string,
	{ programId, version, weekLineage }: WeekAtVersion,
	deps: Pick<TrainingDeps, 'db'> = {}
): Promise<WeekChanges | null> {
	if (!isUuid(programId) || !isUuid(weekLineage)) return null;
	const { db } = resolveDeps(deps);
	const programs = createProgramsRepository(db);
	const found = await programs.latestDecisionOnWeek(ownerId, {
		programId,
		number: version,
		weekLineage,
		kind: 'review_applied'
	});
	if (!found) return null;
	const decisions = await programs.decisionsOf(found.id);
	const reviewId = (found.evidence as { reviewId?: unknown } | null)?.reviewId;
	const review =
		typeof reviewId === 'string' && isUuid(reviewId)
			? await createReviewsRepository(db).weeklyReview(ownerId, reviewId)
			: null;
	return {
		version: { number: found.number, createdBy: found.createdBy },
		applied: decisions.find((d) => d.kind === 'review_applied')?.why ?? '',
		changes: decisions
			.filter((d) => d.kind !== 'review_applied')
			.map(({ summary, why }) => ({ summary, why })),
		review: review && { weekStartsOn: review.weekStartsOn }
	};
}
