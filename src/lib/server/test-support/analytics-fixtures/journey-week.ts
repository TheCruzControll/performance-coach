/**
 * The weekly loop's starting point (M6 journey-weekly-review): a week the owner is about to
 * finish, whose review proposes changes to a next week that is still planned.
 *
 * - journey-week: review-ahead's block and history (this week the block's third, next week its
 *   last, bench easier than its target last week and this one), with today's evening easy run,
 *   today's last session, still to log (lineages.pending) and no review stored. Next week's
 *   Monday and Thursday get review-ahead's fixed 85 kg bench line (lineages.benchMonday,
 *   lineages.benchThursday), so once the run is logged the week is reviewable early and its
 *   review proposes bench +2.5 kg with a half step on each day, on any weekday.
 *
 * Why not week-almost-complete, as the plan names it: that week is its block's last, so the
 * review's next week starts a new block and the card offers the cycle review, not changes.
 * TEST ONLY, like the rest of this folder.
 */
import { addDays } from '../../../domain/calendar';
import type { AnalyticsFixture } from './index';
import { AHEAD, fixedBench } from './review-aged';
import { weekly, type Layout, type ReviewFixtureResult } from './reviews';

/** review-ahead's layout, today's last session left to log. */
const JOURNEY: Layout = { ...AHEAD, today: 'all_but_last' };

export const fixtures = {
	'journey-week': async (ctx): Promise<ReviewFixtureResult> => {
		const seeded = (await weekly(JOURNEY, 0)(ctx)) as ReviewFixtureResult;
		if (seeded.review.kind !== 'weekly') throw new Error('A weekly scenario');
		const next = seeded.review.nextWeekStartsOn;
		const benchMonday = await fixedBench(ctx, next);
		const benchThursday = await fixedBench(ctx, addDays(next, 3));
		return { ...seeded, lineages: { ...seeded.lineages, benchMonday, benchThursday } };
	}
} satisfies Record<string, AnalyticsFixture>;
