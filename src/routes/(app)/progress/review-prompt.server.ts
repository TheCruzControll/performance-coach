/**
 * The review prompt Today's Program panel and Progress's Overview put at the top when a week or
 * a block completes (m6 review-entry-points): one tap from creating its review, or from reading
 * it once it exists. Words are composed here, with the data they describe, so the prompt ships
 * none of the vocabulary. Kept out of the loads so a test runs it with the services faked.
 *
 * One prompt at most, read one query at a time, in this order:
 * 1. a block to review (cycle-review-service's unreviewedBlock, reviewable today): 'Block
 *    complete', whose review covers its last week too
 * 2. a started block's review, newest block first, until SEE_REVIEW_DAYS after the block ends:
 *    the ended block's too once the next one has started, so its last week is not asked again
 * 3. a week to review (weekly-review-service's reviewableWeek): 'Your week in review is ready'
 * 4. this week's review (written early), else last week's: 'See your review'
 *
 * Only with a program, and only for a week its plan covers: the week before week 1, a bridge week
 * between blocks (or one after everything planned) has nothing to review, though the reviews
 * list still offers it.
 */
import { resolve } from '$app/paths';
import { addDays, mondayOf, type IsoDate } from '#lib/domain/calendar.ts';
import { BRIDGE_PHASE } from '#lib/domain/programming/next-block/dates.ts';
import { getCurrentProgram } from '#lib/server/services/programs/index.ts';
import {
	getLiveCycleReview,
	getLiveWeeklyReview,
	reviewableWeek,
	unreviewedBlock
} from '#lib/server/services/reviews/index.ts';
import type { TrainingDeps } from '#lib/server/services/training/shared.ts';
import type { ReviewPromptView } from '#lib/ui/analytics/review-prompt.ts';
import { shortDate } from '#lib/ui/program/words.ts';

/**
 * How long 'See your review' stays once the review exists, in days after the reviewed week or
 * block ends: through the week after it. The m6-plan leaves it open; change it here.
 */
export const SEE_REVIEW_DAYS = 7;

/**
 * The reviews list's words for a refusal (NOT_REVIEWABLE_WORDS and CYCLE_NOT_REVIEWABLE_WORDS in
 * ReviewList.svelte), which the prompt repeats: change them together. Copied, not imported, so
 * the reviews route's initial JS does not grow.
 */
const NOT_READY = {
	weekly: 'Your review is ready after Sunday, or once every session is done or skipped',
	cycle: 'Your cycle review is ready once the block ends, or once its last week is done'
} as const;

export interface ReviewPromptDeps extends Pick<TrainingDeps, 'db'> {
	program?: typeof getCurrentProgram;
	block?: typeof unreviewedBlock;
	cycleReview?: typeof getLiveCycleReview;
	week?: typeof reviewableWeek;
	weekReview?: typeof getLiveWeeklyReview;
}

const reviewsHref = (key?: string) => resolve('/(app)/progress/reviews/[[key]]', { key });
const span = (from: IsoDate, to: IsoDate) => `${shortDate(from)} – ${shortDate(to)}`;

/** The prompt on the owner's `today`, or null when no review is due or newly written. */
export async function loadReviewPrompt(
	ownerId: string,
	today: IsoDate,
	{
		db,
		program: currentProgram = getCurrentProgram,
		block: blockToReview = unreviewedBlock,
		cycleReview = getLiveCycleReview,
		week: weekToReview = reviewableWeek,
		weekReview = getLiveWeeklyReview
	}: ReviewPromptDeps = {}
): Promise<ReviewPromptView | null> {
	const program = await currentProgram(ownerId, today, { db });
	if (!program) return null;

	const due = await blockToReview(ownerId, today, { db });
	if (due?.reviewable) {
		const { programId, blockLineage, name, startsOn, endsOn } = due;
		return {
			kind: 'cycle',
			state: 'due',
			title: 'Block complete — review it and plan the next',
			summary: `${name} · ${span(startsOn, endsOn)}: what it built, and how your next block starts.`,
			href: null,
			create: { action: `${reviewsHref()}?/createCycle`, fields: { programId, blockLineage } },
			notReady: NOT_READY.cycle
		};
	}

	// Planned blocks, less a late start's bridge (BRIDGE_PHASE, the only block of that phase):
	// its weeks are unplanned.
	const planned = program.blocks.filter((b) => b.plannedWeeks > 0 && b.phase !== BRIDGE_PHASE);
	const recent = planned.filter(
		(b) => b.startsOn <= today && today <= addDays(b.endsOn, SEE_REVIEW_DAYS)
	);
	for (const block of recent.reverse()) {
		const review = await cycleReview(ownerId, program.id, block.lineage, { db });
		if (review) return seen('cycle', 'Your block in review', `c-${review.id}`, review.summary);
	}

	// A week of a planned block, from the program's first planned day.
	const covered = (monday: IsoDate) =>
		addDays(monday, 6) >= program.firstPlannedDay &&
		monday <= program.lastPlannedDay &&
		planned.some((b) => b.startsOn <= addDays(monday, 6) && monday <= b.endsOn);
	const week = await weekToReview(ownerId, today, { db });
	if (week && covered(week.weekStartsOn)) {
		const monday = week.weekStartsOn;
		return {
			kind: 'weekly',
			state: 'due',
			title: 'Your week in review is ready',
			summary: `${span(monday, addDays(monday, 6))}: how it went, and what changes next week.`,
			href: null,
			create: { action: `${reviewsHref()}?/create`, fields: { weekStartsOn: monday } },
			notReady: NOT_READY.weekly
		};
	}

	const thisWeek = mondayOf(today);
	for (const monday of [thisWeek, addDays(thisWeek, -7)]) {
		if (!covered(monday)) continue;
		const review = await weekReview(ownerId, monday, { db });
		if (review) return seen('weekly', 'Your week in review', `w-${monday}`, review.summary);
	}
	return null;
}

function seen(
	kind: ReviewPromptView['kind'],
	title: string,
	key: string,
	summary: string
): ReviewPromptView {
	const href = reviewsHref(key);
	return { kind, state: 'reviewed', title, summary, href, create: null, notReady: NOT_READY[kind] };
}
