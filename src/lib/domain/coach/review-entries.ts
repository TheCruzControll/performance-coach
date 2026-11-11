/**
 * The entries a review's write-up thread is opened with (agent/reviews/narrate.ts, M6). Such a
 * thread is the coach's working space for one review, not a conversation: the owner's lists, the
 * thread summaries and memory's other-threads section all leave it out by this entry. Reviews
 * reach the coach's memory as reviews instead (services/coach/memory-records.ts).
 * They are not weekly_review and cycle_review: those are the entries of 'Discuss with your coach'
 * (the M6 plan's review-narrative-ui), a normal conversation that stays listed.
 */
export const REVIEW_ENTRIES = Object.freeze([
	'weekly_review_writeup',
	'cycle_review_writeup'
] as const);
export type ReviewEntry = (typeof REVIEW_ENTRIES)[number];

/** Whether a thread opened with `entry` is a review's write-up thread. */
export function isReviewEntry(entry: { from: string } | null | undefined): boolean {
	return entry != null && (REVIEW_ENTRIES as readonly string[]).includes(entry.from);
}
