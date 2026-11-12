/**
 * When a conversation moves to its next segment (M5, the plan's 'Summaries'). Long threads are
 * never edited and never replayed whole: at the start of a turn, a segment that has grown too long
 * becomes a thread_summary note, and the turn's owner message opens a new segment, whose preamble
 * carries a fresh memory snapshot and that summary.
 *
 * A segment rolls over, before the turn's owner message is stored, when:
 * - the prompt version changed (a new system prompt, tool set or model), or
 * - the last served chat call of its last turn sent SEGMENT.inputTokens or more (cache reads and
 *   writes included), or
 * - it holds SEGMENT.messages messages or more: owner messages and the coach's assistant rows, not
 *   the preamble, context or tool results.
 *
 * The summary (summariseSegment) runs before the turn's transaction, so no transaction is held
 * open across a model call:
 * - a run of kind 'summary' on the segment's last owner message records the call, its tokens and
 *   cost (so the daily cap counts it) and how it ended; a live run on the thread makes the turn
 *   busy before any call
 * - one structured-output call at SUMMARY_EFFORT (prompt/summary.ts), within SUMMARY_TIMEOUT_MS
 * - the result is checked again with zod, then stored as a thread_summary note naming the run
 * Inside the transaction, rollover() starts the segment (startSegment, on the current prompt
 * version and active program version) only if the thread is still on the segment summarised.
 * Stored rows are never edited or deleted: the old segment stays on screen and leaves the replay.
 *
 * The failure path. Owner decision (an implementer's default the M5 plan leaves open): a due
 * rollover happens even when a summary call made for it fails (a refusal, a provider error,
 * invalid output) or no provider exists. The next segment then opens with the memory snapshot and
 * no summary, so a long thread is never replayed whole, and the chip says the summary failed.
 * ROLL_WITHOUT_SUMMARY is that choice; false keeps such a segment until a summary succeeds.
 * A summary that was never really attempted rolls nothing over: the daily cap already spent (the
 * call is skipped) or the client leaving mid-call keeps the segment for a later turn to summarise.
 * A prompt version change rolls regardless.
 *
 * Off the critical path (owner decision 2026-11-11): the summary need not delay an answer. When a
 * completed answer leaves its segment due, summariseAhead makes the summary after that answer has
 * streamed, while the owner reads it, and stores it naming the last row it read (throughSeq). The
 * next turn's summariseSegment first waits for a summary still being made on the thread, then
 * uses a stored one that read every row of the segment, with no model call before its answer; it
 * summarises inline only when there is none (the summary ahead failed, ran out of time, or the
 * segment changed since).
 *
 * One query at a time: every service call is awaited before the next (docs/architecture.md).
 */
import {
	DAILY_LIMITS,
	SEGMENT,
	TURN_LIMITS,
	type SegmentLimits
} from '../../domain/coach/budgets.ts';
import { isReviewEntry } from '../../domain/coach/review-entries.ts';
import {
	summaryText,
	threadSummarySchema,
	type ThreadSummary
} from '../../domain/coach/summary.ts';
import { validate } from '../../domain/validation.ts';
import { logger } from '../observability/logger.ts';
import { latestNotes, saveNote } from '../services/coach/notes.ts';
import {
	finishRun,
	lastCallInputTokens,
	listRuns,
	recordModelCall,
	spentToday,
	startRun
} from '../services/coach/runs.ts';
import type { CoachDeps } from '../services/coach/shared.ts';
import {
	findOwnerMessage,
	getTranscript,
	startSegment,
	type CoachThread,
	type TranscriptRow
} from '../services/coach/threads.ts';
import type { ActivityEvent } from './hooks.ts';
import { modelUsage } from './orchestrator.ts';
import { SUMMARY_EFFORT, summaryRequest } from './prompt/summary.ts';
import { CoachProviderError, type LlmProvider, type StructuredResult } from './provider/types.ts';

/** Owner decision: a due rollover happens even when its summary fails (see the module comment). */
export const ROLL_WITHOUT_SUMMARY = true;

/** The longest a summary call may take: a draft's time, so the turn keeps the rest of its own. */
export const SUMMARY_TIMEOUT_MS = TURN_LIMITS.draftMs;

/** The run a summary is recorded in (agent_runs.kind). */
export const SUMMARY_RUN_KIND = 'summary';

/** How often a turn looks again while a summary ahead is still being made on its thread. */
export const SUMMARY_POLL_MS = 200;

export type RolloverReason = 'prompt_version' | 'input_tokens' | 'messages';

/** What summariseSegment did, for rollover() and the turn's chip. */
export interface RolloverPlan {
	/** The segment that ends. */
	segment: number;
	reason: RolloverReason;
	/** The summary the next segment's preamble carries; null when it failed. */
	summary: string | null;
	noteId: string | null;
}

export interface SummariseInput {
	ownerId: string;
	threadId: string;
	/** The turn's client message id: a retried send rolls nothing over. */
	clientMessageId: string;
	promptVersion: string;
	/** Null when the coach has no provider (direct answers only): no summary is made. */
	provider: LlmProvider | null;
	/** A turn's calls numbered from here are drafts, not chat calls (turn.ts). */
	chatCallsBelow: number;
	signal: AbortSignal;
	deps: CoachDeps;
	limits?: SegmentLimits;
}

/** A summary made after a turn's answer, for the next turn (summariseAhead). */
export interface AheadInput {
	ownerId: string;
	threadId: string;
	promptVersion: string;
	provider: LlmProvider;
	chatCallsBelow: number;
	/** When the endpoint must have finished, in epoch milliseconds: the call ends by then. */
	deadlineAt: number;
	deps: CoachDeps;
	limits?: SegmentLimits;
}

type DueInput = Pick<SummariseInput, 'ownerId' | 'promptVersion' | 'chatCallsBelow' | 'deps'> & {
	limits?: SegmentLimits;
};

const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Why the thread's current segment must roll over before the turn, or null. */
async function dueReason(
	input: DueInput,
	thread: CoachThread,
	rows: readonly TranscriptRow[]
): Promise<RolloverReason | null> {
	const limits = input.limits ?? SEGMENT;
	if (thread.segmentPromptVersion !== input.promptVersion) return 'prompt_version';
	const messages = rows.filter((row) => row.kind === 'owner_message' || row.kind === 'assistant');
	if (messages.length >= limits.messages) return 'messages';
	const lastRun = rows.findLast((row) => row.runId !== null)?.runId ?? null;
	if (lastRun === null) return null;
	const below = input.chatCallsBelow;
	const tokens = await lastCallInputTokens(input.ownerId, lastRun, { below }, input.deps);
	return tokens !== null && tokens >= limits.inputTokens ? 'input_tokens' : null;
}

/** The summary call, recorded in its own run: the summary, or null when it failed. */
async function summarise(
	input: Pick<SummariseInput, 'ownerId' | 'signal' | 'deps'> & { provider: LlmProvider },
	thread: CoachThread,
	rows: readonly TranscriptRow[]
): Promise<{ summary: ThreadSummary; runId: string } | null> {
	const { ownerId, provider, deps } = input;
	const trigger = rows.findLast((row) => row.kind === 'owner_message');
	if (!trigger) return null;
	const run = await startRun(
		ownerId,
		{
			threadId: thread.id,
			triggerMessageId: trigger.id,
			kind: SUMMARY_RUN_KIND,
			provider: provider.name,
			model: provider.model,
			effort: SUMMARY_EFFORT,
			promptVersion: thread.segmentPromptVersion
		},
		deps
	);
	const startedAt = Date.now();
	let result: StructuredResult<unknown> | null = null;
	let failed: CoachProviderError | null = null;
	try {
		const signal = AbortSignal.any([input.signal, AbortSignal.timeout(SUMMARY_TIMEOUT_MS)]);
		result = await provider.structured(summaryRequest(rows), threadSummarySchema, signal);
	} catch (error) {
		// A summary never fails the turn: anything but a provider error is logged and the run fails.
		if (!(error instanceof CoachProviderError)) {
			logger.error('coach summary failed', { runId: run.id, err: error });
			await finishRun(ownerId, run.id, { status: 'failed', error: 'internal' }, deps);
			return null;
		}
		failed = error;
	}

	// Output that fails the schema was still completed and billed: record its usage.
	const completed = result ?? failed?.result ?? null;
	const message = completed?.message ?? null;
	const usage = message ? modelUsage(message.usage, message.model) : NO_USAGE;
	const stop = message?.stop_reason ?? null;
	const call = {
		index: 0,
		requestId: completed?.requestId ?? null,
		model: message?.model ?? null,
		stopReason: stop,
		stopDetails: { category: message?.stop_details?.category ?? null },
		usage,
		ttftMs: null,
		latencyMs: Date.now() - startedAt,
		error: failed?.kind ?? null
	};
	const cost = await recordModelCall(ownerId, run.id, call, deps);
	logger.info('coach model call', {
		runId: run.id,
		purpose: 'summary',
		requestId: call.requestId,
		model: call.model,
		stopReason: stop,
		...usage,
		...cost,
		latencyMs: call.latencyMs,
		error: call.error
	});

	const checked =
		result && stop === 'end_turn' ? validate(threadSummarySchema, result.value) : null;
	if (!checked?.ok) {
		const error = failed?.kind ?? (stop === 'end_turn' || stop === null ? 'invalid_output' : stop);
		const status = stop === 'refusal' ? 'refused' : 'failed';
		await finishRun(ownerId, run.id, { status, error }, deps);
		return null;
	}
	await finishRun(ownerId, run.id, { status: 'completed' }, deps);
	return { summary: checked.data, runId: run.id };
}

/** The stored summary of the thread's current segment that read every row of it, or null. */
async function stored(
	ownerId: string,
	thread: CoachThread,
	rows: readonly TranscriptRow[],
	deps: CoachDeps
) {
	const through = rows.at(-1)?.seq;
	if (through === undefined) return null;
	const notes = await latestNotes(ownerId, 'thread_summary', {}, deps);
	const { id: threadId, segment } = thread;
	const note = notes.find(
		({ body }) =>
			body.threadId === threadId && body.segment === segment && body.throughSeq === through
	);
	return note ? { summary: summaryText(note.body), noteId: note.id } : null;
}

/**
 * While a summary ahead is still being made on the thread, wait for it, up to its own limit. True
 * when it waited.
 */
async function settle(input: SummariseInput, thread: CoachThread): Promise<boolean> {
	const until = Date.now() + SUMMARY_TIMEOUT_MS;
	let waited = false;
	while (Date.now() < until && !input.signal.aborted) {
		const [newest] = (await listRuns(input.ownerId, { limit: 1 }, input.deps)).runs;
		const making =
			newest?.status === 'running' &&
			newest.kind === SUMMARY_RUN_KIND &&
			newest.threadId === thread.id;
		if (!making) return waited;
		waited = true;
		await new Promise((resolve) => setTimeout(resolve, SUMMARY_POLL_MS));
	}
	return waited;
}

/** The summary as a thread_summary note, naming the run and the last row it read. */
function saveSummary(
	ownerId: string,
	thread: CoachThread,
	rows: readonly TranscriptRow[],
	made: { summary: ThreadSummary; runId: string },
	deps: CoachDeps
) {
	const body = { threadId: thread.id, segment: thread.segment, throughSeq: rows.at(-1)?.seq };
	return saveNote(
		ownerId,
		{
			kind: 'thread_summary',
			body: { ...body, ...made.summary },
			summary: made.summary.summary,
			runId: made.runId
		},
		deps
	);
}

/**
 * Before a turn's transaction: when the thread's current segment is due to roll over, the summary
 * made ahead for it, or else a summary made now, as a thread_summary note. Null when nothing is
 * due (a retried send, an archived thread, a review's write-up thread, a segment within its
 * limits on the current prompt version).
 */
export async function summariseSegment(input: SummariseInput): Promise<RolloverPlan | null> {
	const { ownerId, deps } = input;
	if (await findOwnerMessage(ownerId, input.clientMessageId, deps)) return null;
	let { thread, rows } = await getTranscript(ownerId, input.threadId, deps);
	// A review's write-up thread is never summarised: memory carries the review itself.
	if (thread.archived || isReviewEntry(thread.entry)) return null;
	const reason = await dueReason(input, thread, rows);
	if (reason === null) return null;

	const plan: RolloverPlan = { segment: thread.segment, reason, summary: null, noteId: null };
	if (input.provider && (await settle(input, thread))) {
		// Read again: a send that rolled the thread over meanwhile leaves nothing to summarise.
		({ thread, rows } = await getTranscript(ownerId, input.threadId, deps));
		if (thread.segment !== plan.segment) return null;
	}
	const ahead = await stored(ownerId, thread, rows, deps);
	if (ahead) return { ...plan, ...ahead };
	// Not attempted (cap spent, client gone): only a prompt version change still rolls over.
	const later = reason === 'prompt_version' ? plan : null;
	const { provider } = input;
	if (!provider) return plan;
	if ((await spentToday(ownerId, deps)) >= DAILY_LIMITS.costMicros) return later;
	const made = await summarise({ ...input, provider }, thread, rows);
	if (!made) return input.signal.aborted ? later : plan;
	const note = await saveSummary(ownerId, thread, rows, made, deps);
	return { ...plan, summary: summaryText(made.summary), noteId: note.id };
}

/**
 * After a turn's completed answer: when it left the segment due to roll over, summarise the
 * segment now, so the next turn starts its answer with no summary call. True when a summary was
 * stored. A provider error fails only its summary run; the caller logs anything else.
 */
export async function summariseAhead(input: AheadInput): Promise<boolean> {
	const { ownerId, deps } = input;
	const { thread, rows } = await getTranscript(ownerId, input.threadId, deps);
	if (thread.archived || isReviewEntry(thread.entry)) return false;
	if ((await dueReason(input, thread, rows)) === null) return false;
	const ms = Math.min(SUMMARY_TIMEOUT_MS, input.deadlineAt - Date.now());
	if (ms <= 0 || (await spentToday(ownerId, deps)) >= DAILY_LIMITS.costMicros) return false;
	const made = await summarise({ ...input, signal: AbortSignal.timeout(ms) }, thread, rows);
	if (!made) return false;
	await saveSummary(ownerId, thread, rows, made, deps);
	return true;
}

export interface RolloverInput {
	ownerId: string;
	thread: CoachThread;
	promptVersion: string;
	/** The active program version the next segment starts on. */
	programVersionId: string | null;
	/** What summariseSegment did before the transaction; null when nothing was due. */
	plan: RolloverPlan | null;
	deps: CoachDeps;
}

/**
 * Inside the turn's transaction, before its owner message is stored: the thread to continue on,
 * and the summary the next segment's preamble carries. The segment starts when the plan was made
 * on the thread's current segment (a concurrent send may have rolled it meanwhile), or whenever
 * the prompt version changed.
 */
export async function rollover(
	input: RolloverInput
): Promise<{ thread: CoachThread; summary: string | null }> {
	const { ownerId, thread, promptVersion, programVersionId, plan, deps } = input;
	const planned =
		plan !== null &&
		plan.segment === thread.segment &&
		(plan.summary !== null || ROLL_WITHOUT_SUMMARY);
	if (!planned && thread.segmentPromptVersion === promptVersion) return { thread, summary: null };
	const next = await startSegment(ownerId, thread.id, { promptVersion, programVersionId }, deps);
	return { thread: next, summary: planned ? plan.summary : null };
}

/** The chip a turn that rolled over shows, after run_started. */
export function rolloverChip(plan: RolloverPlan): ActivityEvent {
	const done = plan.summary !== null;
	return {
		type: 'activity',
		id: `summary_${plan.segment}`,
		tool: SUMMARY_RUN_KIND,
		state: done ? 'done' : 'failed',
		label: done ? 'Summarised our earlier messages' : 'Couldn’t summarise our earlier messages'
	};
}
