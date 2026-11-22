/**
 * What a review prompt (ReviewPrompt.svelte) shows, composed on the server
 * (routes/(app)/progress/review-prompt.server.ts) so the component ships none of the words:
 * a week or a block to review with the form that creates it, or the review once it exists.
 */
export interface ReviewPromptView {
	kind: 'weekly' | 'cycle';
	/** due: not reviewed yet, and reviewable now; reviewed: its review exists. */
	state: 'due' | 'reviewed';
	/** 'Your week in review is ready', 'Block complete — review it and plan the next', … */
	title: string;
	/** The dates it covers and what the review holds, or the stored review's summary. */
	summary: string;
	/** reviewed: the review's page; null while it is due. */
	href: string | null;
	/** due: the reviews screen's create action and the fields it posts; null once reviewed. */
	create: { action: string; fields: Record<string, string> } | null;
	/** What a refusal (409, not reviewable yet) says, before the day it will be ready. */
	notReady: string;
}
