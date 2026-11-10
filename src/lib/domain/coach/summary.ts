/**
 * A thread summary (M5, the plan's 'Summaries'): what a long conversation segment becomes before
 * the next one starts, so the coach continues from structured notes and never replays a long
 * transcript (agent/rollover.ts).
 *
 * - threadSummarySchema is the structured-output shape the summary call answers with (effort low):
 *   a few sentences, then what was agreed, what the owner said about themselves and what is still
 *   open. The provider sends it as strict JSON Schema; zod checks it again with the bounds JSON
 *   Schema drops.
 * - threadSummaryNoteSchema is the thread_summary note's body: the summary, and the conversation
 *   and segment it closes. The note's summary column is the summary's `summary`, which memory
 *   lists; summaryText is what the next segment's preamble carries.
 *
 * Server-only: imported by path, never through ./index.ts (scripts/coach-index-imports.test.ts).
 */
import * as z from 'zod/mini';

/** The longest `summary`: the note's summary column (NOTE_SUMMARY_MAX in db/schema/coach.ts). */
export const SUMMARY_TEXT_MAX = 1000;
export const SUMMARY_ITEM_MAX = 300;
export const SUMMARY_ITEMS_MAX = 8;

const closed = <S extends z.core.$ZodLooseShape>(shape: S) =>
	z.strictObject(shape, {
		error: (issue) =>
			issue.code === 'unrecognized_keys' ? `Unknown field: ${issue.keys.join(', ')}` : undefined
	});
const text = (max: number, required: string) =>
	z
		.string(required)
		.check(z.trim(), z.minLength(1, required), z.maxLength(max, `Up to ${max} characters`));
const items = (required: string) =>
	z
		.array(text(SUMMARY_ITEM_MAX, 'Say something'), required)
		.check(z.maxLength(SUMMARY_ITEMS_MAX, `Up to ${SUMMARY_ITEMS_MAX} items`));

const summaryShape = {
	/** What the segment covered and where it ended, in a few sentences. */
	summary: text(SUMMARY_TEXT_MAX, 'Summarise the conversation'),
	/** Decisions, plans and changes the owner and the coach agreed. */
	agreed: items('List what was agreed'),
	/** What the owner said about themselves that should shape later coaching. */
	ownerSaid: items('List what the owner said'),
	/** What was left unanswered or promised for later. */
	openQuestions: items('List what is still open')
};

/** What the summary call answers. Every list may be empty. */
export const threadSummarySchema = closed(summaryShape);
export type ThreadSummary = z.output<typeof threadSummarySchema>;

/** A thread_summary note's body: the summary of one segment of one conversation. */
export const threadSummaryNoteSchema = closed({
	threadId: z.uuid('Unknown conversation'),
	segment: z.int('Name the segment').check(z.minimum(1, 'Segments start at 1')),
	...summaryShape
});
export type ThreadSummaryNote = z.output<typeof threadSummaryNoteSchema>;

/** The summary as one text: its sentences, then each non-empty list on its own line. */
export function summaryText(summary: ThreadSummary): string {
	const list = (label: string, values: readonly string[]) =>
		values.length === 0 ? [] : [`${label}: ${values.join('; ')}`];
	return [
		summary.summary,
		...list('Agreed', summary.agreed),
		...list('The owner said', summary.ownerSaid),
		...list('Still open', summary.openQuestions)
	].join('\n');
}
