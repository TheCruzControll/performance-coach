/**
 * A review's write-up (M6, the plan's 'The deterministic review never waits for the LLM'): one
 * coach turn adds the narrative and recommendations to a weekly or cycle review the rules already
 * computed, stored and proposed. Called only from the api/reviews/narrate endpoint.
 *
 * - The turn runs in the review's own write-up thread (entry weekly_review_writeup or
 *   cycle_review_writeup, titled 'Week of 2 Nov: review'), which the owner's lists, thread
 *   summaries and memory leave out (domain/coach/review-entries.ts). Its owner message ('Review my
 *   week of 2 Nov') has a client message id derived from the review's id and revision, so every
 *   call finds the same thread.
 * - It goes through agent/coach.ts like any turn: the launch gate, the 'coach.turn' rate limit and
 *   the daily cost cap. It can only read (toolEffects ['read']), so it never makes a second
 *   proposal; its turn context names the review's proposal and the decision on it, as data.
 * - It takes no AbortSignal: nothing the request does can cancel it. Once started, the run
 *   completes and is stored for the next visit, whoever is still waiting.
 * - What is stored, once, is the released text of the run's display blocks: each block's label
 *   and words as the owner saw them, the output policy's replacements included, never the model's
 *   raw output.
 * - A superseded review is never written up (ReviewSupersededError); a stored write-up is returned
 *   as it is, with no new run; a run still live on the thread is busy, with its run id.
 * - A coach outage never blocks the review: every way the coach cannot answer is an outcome.
 *
 * Owner decision (open question 'review write-up'): a review is written up by one read-only turn
 * per revision, in a thread hidden from the owner's conversations; discussing it starts a separate,
 * visible conversation. When the turn runs (on first opening, or only on 'Ask your coach') is the
 * caller's choice, so changing it never touches this module.
 *
 * One query at a time: every service call is awaited before the next (docs/architecture.md).
 */
import { createHash } from 'node:crypto';
import type { IsoDate } from '../../../domain/calendar.ts';
import { DAILY_LIMITS } from '../../../domain/coach/budgets.ts';
import type { CompletedBlock } from '../../../domain/coach/events.ts';
import type { ReviewEntry } from '../../../domain/coach/review-entries.ts';
import type { RichNode } from '../../../domain/coach/rich.ts';
import { reviewKey } from '../../../domain/coach/sources.ts';
import type { ToolEffect } from '../../../domain/coach/tools.ts';
import {
	ANSWER_BLOCK_KIND_LABEL,
	type CoachErrorKind,
	type CoachUnavailableReason
} from '../../../domain/coach/vocabulary.ts';
import { AuthError } from '../../auth/errors.ts';
import { liveRun, spentToday } from '../../services/coach/runs.ts';
import type { CoachDeps } from '../../services/coach/shared.ts';
import { findOwnerMessage, getThreadView } from '../../services/coach/threads.ts';
import {
	decisionOf,
	getCycleReview,
	getWeeklyReview,
	narrativeBlocks,
	proposalHead,
	ReviewSetOnceError,
	ReviewSupersededError,
	setNarrative,
	type ReviewKind,
	type StoredReview
} from '../../services/reviews/store.ts';
import { admitCoachTurn, coachStatus, runCoachTurn } from '../coach.ts';

/** A write-up turn reads; it never proposes or writes. */
export const NARRATION_TOOL_EFFECTS: readonly ToolEffect[] = Object.freeze(['read']);

/** The proposal kind each review makes. */
const PROPOSAL_KIND: Record<ReviewKind, string> = {
	weekly: 'program_adjustment',
	cycle: 'next_cycle'
};

const ENTRY: Record<ReviewKind, ReviewEntry> = {
	weekly: 'weekly_review_writeup',
	cycle: 'cycle_review_writeup'
};

export interface ReviewTarget {
	kind: ReviewKind;
	id: string;
}

export type NarrationUnavailable = CoachUnavailableReason | 'budget' | 'rate_limited' | 'busy';

export type NarrationOutcome =
	| { outcome: 'written'; narrative: string; runId: string | null; threadId: string | null }
	| {
			outcome: 'unavailable';
			reason: NarrationUnavailable;
			/** The live run, when busy. */
			runId?: string;
			/** When rate-limited: seconds until a turn may run. */
			retryAfterS?: number;
	  }
	| { outcome: 'failed'; error: CoachErrorKind; runId: string | null };

export type NarrationState =
	| { state: 'written'; narrative: string; runId: string | null; threadId: string | null }
	| { state: 'running'; runId: string }
	| { state: 'none' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2 Nov'. */
const dayMonth = (date: IsoDate) =>
	`${Number(date.slice(8))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;

/** What the review is called in its thread: 'week of 2 Nov', 'block of 12 Oct – 8 Nov'. */
function period(review: StoredReview): string {
	if (review.kind === 'weekly') return `week of ${dayMonth(review.weekStartsOn as IsoDate)}`;
	const { blockStartsOn: from, blockEndsOn: to } = review;
	return from && to
		? `block of ${dayMonth(from as IsoDate)} – ${dayMonth(to as IsoDate)}`
		: 'block';
}

/** The write-up's owner message id: one per review revision, in the UUID shape (version 8). */
export function narrationMessageId(review: Pick<StoredReview, 'kind' | 'id' | 'revision'>): string {
	const hex = createHash('sha256')
		.update(`review-narration:${review.kind}:${review.id}:${review.revision}`)
		.digest('hex');
	const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A rich-text tree's words as one line, each ref as its label. */
function words(nodes: readonly RichNode[]): string {
	const parts: string[] = [];
	const walk = (node: RichNode) => {
		if (node.type === 'text' || node.type === 'code') parts.push(node.text);
		else if (node.type === 'ref') parts.push(node.label);
		else {
			parts.push(' ');
			node.children.forEach(walk);
			parts.push(' ');
		}
	};
	nodes.forEach(walk);
	return parts.join('').replace(/\s+/g, ' ').trim();
}

/** The blocks as the owner saw them, one paragraph each: 'Fact: You skipped 1 session …'. */
export function releasedText(blocks: readonly CompletedBlock[]): string {
	return blocks
		.map((block) => `${ANSWER_BLOCK_KIND_LABEL[block.kind]}: ${words(block.ast)}`)
		.join('\n\n');
}

async function loadReview(ownerId: string, target: ReviewTarget, deps: CoachDeps) {
	return target.kind === 'weekly'
		? getWeeklyReview(ownerId, target.id, deps)
		: getCycleReview(ownerId, target.id, deps);
}

const written = (review: StoredReview) =>
	({
		narrative: review.narrative!,
		runId: review.narrativeRunId,
		threadId: review.narrativeThreadId
	}) as const;

/** The stored write-up, the run writing it, or neither. */
export async function narrationState(
	ownerId: string,
	target: ReviewTarget,
	deps: CoachDeps = {}
): Promise<NarrationState> {
	const review = await loadReview(ownerId, target, deps);
	if (review.narrative !== null) return { state: 'written', ...written(review) };
	const asked = await findOwnerMessage(ownerId, narrationMessageId(review), deps);
	const live = asked && (await liveRun(ownerId, asked.threadId, deps));
	return live ? { state: 'running', runId: live.id } : { state: 'none' };
}

/**
 * The display blocks of the run that wrote a review's write-up, as its thread stored them (the
 * output policy's replacements included): what the reviews screen draws with M5's AnswerBlocks.
 */
export async function narrationBlocks(
	ownerId: string,
	{ runId, threadId }: { runId: string | null; threadId: string | null },
	deps: CoachDeps = {}
): Promise<CompletedBlock[]> {
	const rows = await narrativeBlocks(
		ownerId,
		{ narrativeRunId: runId, narrativeThreadId: threadId },
		deps
	);
	return rows.flatMap((row) =>
		row.kind === 'assistant'
			? ((row.display as { blocks?: CompletedBlock[] } | null)?.blocks ?? [])
			: []
	);
}

/** The run that wrote the answer `messageId`, read back from its thread (a retried write-up). */
async function answerRun(ownerId: string, threadId: string, messageId: string, deps: CoachDeps) {
	const { messages } = await getThreadView(ownerId, threadId, {}, deps);
	return messages.find((message) => message.id === messageId)?.runId ?? null;
}

/** Write the review up, once; see the module comment for every outcome. */
export async function narrateReview(
	ownerId: string,
	target: ReviewTarget,
	deps: CoachDeps = {}
): Promise<NarrationOutcome> {
	const review = await loadReview(ownerId, target, deps);
	if (review.narrative !== null) return { outcome: 'written', ...written(review) };
	if (review.supersededAt !== null) throw new ReviewSupersededError();
	const clientMessageId = narrationMessageId(review);
	const asked = await findOwnerMessage(ownerId, clientMessageId, deps);
	const busy = async (threadId: string | undefined): Promise<NarrationOutcome | null> => {
		const live = threadId === undefined ? null : await liveRun(ownerId, threadId, deps);
		return live && { outcome: 'unavailable', reason: 'busy', runId: live.id };
	};
	const running = await busy(asked?.threadId);
	if (running) return running;

	const status = coachStatus();
	if (status.status === 'unavailable') return { outcome: 'unavailable', reason: status.reason };
	if ((await spentToday(ownerId, deps)) >= DAILY_LIMITS.costMicros)
		return { outcome: 'unavailable', reason: 'budget' };
	try {
		await admitCoachTurn(null, deps);
	} catch (error) {
		if (!(error instanceof AuthError) || error.code !== 'rate_limited') throw error;
		return { outcome: 'unavailable', reason: 'rate_limited', retryAfterS: error.retryAfter };
	}

	const head = await proposalHead(ownerId, review, deps);
	const decision = decisionOf(head);
	const label = period(review);
	const key = reviewKey(review);
	const turn = runCoachTurn(
		{
			ownerId,
			threadId: asked?.threadId ?? null,
			clientMessageId,
			text: `Review my ${label}`,
			entry: { from: ENTRY[review.kind], ref: { type: 'review', id: key } },
			title: `${label[0]!.toUpperCase()}${label.slice(1)}: review`,
			review: {
				proposal:
					decision.state === 'none'
						? null
						: {
								id: decision.proposalId,
								// A weekly review's head is M6's changes, or M7's deload (a replan).
								kind: head?.kind ?? PROPOSAL_KIND[review.kind],
								decision: decision.state
							}
			},
			// Never aborted: leaving the page does not cancel a write-up.
			signal: new AbortController().signal
		},
		{ deps, toolEffects: NARRATION_TOOL_EFFECTS }
	);
	let threadId = asked?.threadId ?? null;
	let runId: string | null = null;
	let answer: string | null = null;
	let error: { kind: CoachErrorKind; reason?: CoachUnavailableReason } | null = null;
	let done: string | null = null;
	for await (const event of turn) {
		if (event.type === 'run_started') ({ threadId, runId } = event);
		else if (event.type === 'answer_completed') answer = event.messageId;
		else if (event.type === 'error') error = event;
		else if (event.type === 'done') done = event.status;
	}

	if (error?.kind === 'busy') {
		const now = await busy(
			threadId ?? (await findOwnerMessage(ownerId, clientMessageId, deps))?.threadId
		);
		if (now) return now;
	}
	if (error?.kind === 'unavailable')
		return { outcome: 'unavailable', reason: error.reason ?? 'disabled' };
	if (error?.kind === 'budget') return { outcome: 'unavailable', reason: 'budget' };
	if (done !== 'completed' || answer === null || threadId === null)
		return { outcome: 'failed', error: error?.kind ?? 'provider', runId };
	// Answered by an earlier run whose write-up was never stored: its run is the answer's.
	runId ??= await answerRun(ownerId, threadId, answer, deps);
	if (runId === null) return { outcome: 'failed', error: 'provider', runId };

	const blocks = await narrationBlocks(ownerId, { runId, threadId }, deps);
	const narrative = releasedText(blocks);
	if (narrative === '') return { outcome: 'failed', error: 'provider', runId };
	try {
		await setNarrative(ownerId, review.kind, review.id, { narrative, runId, threadId }, deps);
	} catch (stored) {
		// Written meanwhile by another run: that one is the review's.
		if (!(stored instanceof ReviewSetOnceError)) throw stored;
		return { outcome: 'written', ...written(await loadReview(ownerId, target, deps)) };
	}
	return { outcome: 'written', narrative, runId, threadId };
}
