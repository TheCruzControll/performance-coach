/**
 * A stored cycle review (the screen gallery's cycle-review shot): block-end (reviews.ts) with
 * its block reviewed through the real cycle review service, so the shot has a review to open
 * whether or not the reviews list shows cycle reviews yet. Returns the review's id as
 * `cycleReviewId`.
 *
 * TEST ONLY, like the rest of this folder.
 */
import { createCycleReview } from '../../services/reviews/index';
import type { AnalyticsFixture } from './index';
import { fixtures as reviews, type ReviewFixtureResult } from './reviews';

export interface CycleReviewedResult extends ReviewFixtureResult {
	cycleReviewId: string;
}

export const fixtures = {
	'block-reviewed': async (ctx): Promise<CycleReviewedResult> => {
		const seeded = (await reviews['block-end'](ctx)) as ReviewFixtureResult;
		const { programId, review: target } = seeded;
		if (!programId || target.kind !== 'cycle') throw new Error('block-end seeds a block to review');
		const { review } = await createCycleReview(
			ctx.ownerId,
			{ programId, blockLineage: target.blockLineageId, today: ctx.today },
			{ db: ctx.db, now: () => ctx.now }
		);
		return { ...seeded, cycleReviewId: review.id };
	}
} satisfies Record<string, AnalyticsFixture>;
