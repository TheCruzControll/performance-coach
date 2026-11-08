/**
 * One coach turn: the owner's message in, CoachEvents out, every row stored as it happens (M5,
 * ADR 0013). In order:
 *
 * 1. A coach that is switched off or not launched refuses the turn before anything is written.
 * 2. The day's facts (services/coach/turn-facts.ts): date, time and zone, the active version and
 *    its week through M3's program reads.
 * 3. A new send rolls the thread to a new segment when its prompt version changed (rollover.ts),
 *    and a message that opens a segment stores the memory preamble ahead of it (memory/load.ts).
 *    A retried send (the same client message id) stores nothing: an answered one points at its
 *    stored answer; one whose run never finished runs again on the stored message and its text.
 * 4. The run starts; a live run on the thread makes the turn busy. Steps 3 and 4 are one
 *    transaction, so a busy send stores nothing. The proposals decided since the thread's last
 *    message join the turn context by id, kind and status.
 * 5. A lookup (domain/coach/intents.ts) is answered by direct.ts with no model call, in a run
 *    recorded as DIRECT_RUN; otherwise a misconfigured coach is unavailable, and a day already at
 *    DAILY_LIMITS is out of budget, both before any model call.
 * 6. The loop (orchestrator.ts) runs over the stored segment. Each model call and each step is
 *    stored as it ends; the turn's context message only with its first stored step. Tools get
 *    toolRuntime(deps), so they run one at a time when the services hold a transaction.
 * 7. Visible text goes through the answer parser and the output policy (policy.ts) to the wire;
 *    a completed answer is stored with its blocks; an answer that did not complete is stored as a
 *    display_only row, shown and never replayed, so every stored segment stays a valid request.
 * 8. The run finishes with its outcome; `done` is always the last event.
 *
 * One query at a time: every service call is awaited before the next (docs/architecture.md).
 */
import type {
	BetaMessageParam,
	BetaToolUseBlock,
	BetaUserMessageParam
} from '@anthropic-ai/sdk/resources/beta/messages';
import { createAnswerParser } from '../../domain/coach/answer.ts';
import { DAILY_LIMITS, TURN_LIMITS } from '../../domain/coach/budgets.ts';
import type { CoachEvent, CompletedBlock } from '../../domain/coach/events.ts';
import { directIntent } from '../../domain/coach/intents.ts';
import { detectPain } from '../../domain/coach/safety.ts';
import type {
	CoachErrorKind,
	CoachUnavailableReason,
	MessageStatus,
	RunStatus
} from '../../domain/coach/vocabulary.ts';
import { logger } from '../observability/logger.ts';
import {
	finishRun,
	isCancelRequested,
	recordModelCall,
	recordToolCalls,
	spentToday,
	startRun,
	type RunEnd,
	type ToolCallInput
} from '../services/coach/runs.ts';
import {
	CoachArchivedError,
	CoachBusyError,
	CoachInputError,
	CoachNotFoundError,
	CoachTranscriptError,
	inTransaction,
	toolRuntime,
	type CoachDeps,
	type ResolvedCoachDeps
} from '../services/coach/shared.ts';
import {
	appendDisplayOnly,
	appendTurnStep,
	findOwnerMessage,
	getThreadView,
	getTranscript,
	startOwnerTurn,
	type TurnStep
} from '../services/coach/threads.ts';
import { listDecidedSince } from '../services/coach/proposals.ts';
import { loadTurnFacts } from '../services/coach/turn-facts.ts';
import { directAnswer, DIRECT_RUN } from './direct.ts';
import type { TurnHooks } from './hooks.ts';
import { loadMemory } from './memory/load.ts';
import { rollover } from './rollover.ts';
import { runLoop, type LoopOutcome } from './orchestrator.ts';
import { createOutputPolicy, type PolicyInput } from './policy.ts';
import { segmentPreamble, turnContext, weekSummary, type TurnFacts } from './prompt/context.ts';
import { buildModelRequest, CHAT_EFFORT } from './prompt/layout.ts';
import { promptVersion, SYSTEM_PROMPT } from './prompt/system.ts';
import { DIRECT_ANSWER_REASONS } from './provider/select.ts';
import { COACH_MODEL, type LlmProvider } from './provider/types.ts';
import { toolContext, type TurnEntry } from './tools/context.ts';
import type { CoachTool } from './tools/define.ts';
import type { ToolCallOutcome } from './tools/execute.ts';
import { COACH_TOOLS } from './tools/registry.ts';

export type TurnProvider =
	| { status: 'ready'; provider: LlmProvider }
	| { status: 'unavailable'; reason: CoachUnavailableReason };

export interface TurnInput {
	ownerId: string;
	/** The conversation to continue; absent starts a new one. */
	threadId?: string | null;
	clientMessageId: string;
	text: string;
	entry?: TurnEntry | null;
	/** The request's: it aborts when the client leaves. */
	signal: AbortSignal;
}

export interface TurnOptions {
	provider: TurnProvider;
	deps?: CoachDeps;
	/** The registry's by default; the prompt version is computed from them. */
	tools?: readonly CoachTool<ResolvedCoachDeps>[];
	/** When the endpoint must have answered, in epoch milliseconds. */
	deadlineAt?: number;
}

/** The error a turn that did not complete ends with. budget_exhausted is the turn's own limit. */
export const TURN_ERROR: Record<Exclude<LoopOutcome, 'completed'>, CoachErrorKind> = {
	refused: 'refused',
	budget_exhausted: 'timeout',
	cancelled: 'cancelled',
	interrupted: 'interrupted',
	timed_out: 'timeout',
	failed: 'provider'
};

/** The convention for propose tools: their output names the proposal they stored. */
function proposalOf(outcome: ToolCallOutcome): CoachEvent | null {
	const proposal = (outcome.output as { proposal?: unknown } | null)?.proposal;
	if (outcome.status !== 'succeeded' || !proposal || typeof proposal !== 'object') return null;
	const { id, kind, title } = proposal as Record<string, unknown>;
	if (typeof id !== 'string' || typeof kind !== 'string' || typeof title !== 'string') return null;
	return { type: 'proposal', id, kind, title };
}

/** A pushed queue read as an async iterable, so the loop's callbacks feed the generator. */
function channel<T>() {
	const items: T[] = [];
	let wake: (() => void) | null = null;
	let closed = false;
	const poke = () => {
		wake?.();
		wake = null;
	};
	return {
		push: (item: T) => void (items.push(item), poke()),
		close: () => void ((closed = true), poke()),
		async *drain() {
			for (;;) {
				while (items.length > 0) yield items.shift()!;
				if (closed) return;
				await new Promise<void>((resolve) => (wake = resolve));
			}
		}
	};
}

/**
 * The visible answer: text through the parser and the policy to the wire, the blocks each stored
 * row shows, and the text a void call (a fallback, a re-issue) takes back.
 */
function answerStream(input: PolicyInput, emit: (event: CoachEvent) => void) {
	let parser = createAnswerParser();
	let policy = createOutputPolicy(input);
	const outcomes: ToolCallOutcome[] = [];
	let kept = '';
	let call = '';
	let lastCall = '';
	let storedText = 0;
	let completed: CompletedBlock[] = [];
	let stored = 0;
	const feed = (events: CoachEvent[], send: boolean) => {
		for (const event of events) {
			if (event.type === 'block_completed' || event.type === 'block_replaced') {
				const { block, kind, method, ast, sources, grounded } = event;
				completed.push({ block, kind, method, ast, sources, grounded });
			}
			if (send) emit(event);
		}
	};
	/** The answer starts again from the kept text, which is sent again. */
	const restart = () => {
		parser = createAnswerParser();
		policy = createOutputPolicy(input);
		policy.observe(outcomes);
		completed = [];
		emit({ type: 'answer_reset', reason: 'fallback' });
		feed(policy.push(parser.push(kept)), true);
	};
	return {
		text(text: string) {
			call += text;
			feed(policy.push(parser.push(text)), true);
		},
		/** A fallback model took over this call: its text so far is void. */
		fallback() {
			if (call === '') return;
			call = '';
			restart();
		},
		callEnded() {
			kept += call;
			lastCall = call;
			call = '';
		},
		/** The call that just ended is sent again: its text is void. */
		reissue() {
			if (lastCall === '') return;
			kept = kept.slice(0, kept.length - lastCall.length);
			lastCall = '';
			restart();
		},
		observe(step: readonly ToolCallOutcome[]) {
			outcomes.push(...step);
			policy.observe(step);
		},
		/** The blocks completed since the last stored row. */
		take(): CompletedBlock[] {
			const blocks = completed.slice(stored);
			stored = completed.length;
			storedText = kept.length + call.length;
			return blocks;
		},
		/** The text not yet stored. */
		pending: () => (kept + call).slice(storedText),
		finish(send: boolean) {
			feed(policy.push(parser.end()), send);
			feed(policy.end(), send);
		},
		interventions: () => policy.interventions,
		/** The blocks as the owner saw them, in the answer grammar. */
		textOf: (blocks: readonly CompletedBlock[]) =>
			policy.answerText(blocks.map((block) => block.block))
	};
}

/**
 * The answer's content as stored for replay: when the policy changed what the owner saw, its text
 * blocks become what they were shown, so no stored row keeps what the policy took out.
 */
function policedContent<T extends Readonly<Record<string, unknown>>>(
	content: readonly T[],
	text: string
): T[] {
	const at = content.findIndex((block) => block.type === 'text');
	if (at < 0 || text === '') return [...content];
	return content.flatMap((block, index) =>
		index === at ? [{ ...block, text }] : block.type === 'text' ? [] : [block]
	);
}

function serviceError(error: unknown): CoachErrorKind | null {
	if (error instanceof CoachBusyError) return 'busy';
	if (error instanceof CoachNotFoundError) return 'not_found';
	if (error instanceof CoachInputError || error instanceof CoachArchivedError)
		return 'invalid_request';
	return null;
}

/**
 * The stored answer to an owner message already answered: the last assistant row shown before the
 * next owner message, read back a page at a time until the message itself, however old.
 */
async function storedAnswer(ownerId: string, threadId: string, seq: number, deps: CoachDeps) {
	const later: { id: string; seq: number; kind: string }[] = [];
	let before: number | undefined;
	for (;;) {
		const page = await getThreadView(ownerId, threadId, { before }, deps);
		later.unshift(...page.messages.filter((message) => message.seq > seq));
		if (page.olderBefore === null || (page.messages[0]?.seq ?? 0) <= seq) break;
		before = page.olderBefore;
	}
	const next = later.findIndex((message) => message.kind === 'owner_message');
	const reply = (next < 0 ? later : later.slice(0, next)).findLast(
		(message) => message.kind === 'assistant'
	);
	if (!reply) throw new CoachInputError('clientMessageId', 'That message cannot be retried');
	return reply.id;
}

/** Run one turn; the stream always ends with `done`. */
export async function* runTurn(input: TurnInput, options: TurnOptions): AsyncGenerator<CoachEvent> {
	const out = channel<CoachEvent>();
	const run = { id: null as string | null };
	const work = turn(input, options, out.push, run)
		.catch(async (error: unknown) => {
			const kind = serviceError(error);
			if (kind && run.id === null) {
				out.push({ type: 'error', kind });
				return null;
			}
			logger.error('coach turn failed', { runId: run.id, err: error });
			if (run.id) {
				const end = { status: 'failed', error: 'internal' } as const;
				await finishRun(input.ownerId, run.id, end, options.deps).catch(() => undefined);
			}
			out.push({ type: 'error', kind: kind ?? 'provider' });
			return run.id ? ('failed' as const) : null;
		})
		.then((status) => out.push({ type: 'done', status }))
		.finally(out.close);
	yield* out.drain();
	await work;
}

async function turn(
	input: TurnInput,
	options: TurnOptions,
	emit: (event: CoachEvent) => void,
	run: { id: string | null }
): Promise<RunStatus | null> {
	const { ownerId } = input;
	const { provider } = options;
	const deps = options.deps ?? {};
	if (provider.status === 'unavailable' && !DIRECT_ANSWER_REASONS.includes(provider.reason)) {
		emit({ type: 'error', kind: 'unavailable', reason: provider.reason });
		return null;
	}
	const tools = options.tools ?? (COACH_TOOLS as readonly CoachTool<ResolvedCoachDeps>[]);
	const definitions = tools.map((tool) => tool.definition);
	const version = promptVersion({ system: SYSTEM_PROMPT, tools: definitions, model: COACH_MODEL });
	const day = await loadTurnFacts(ownerId, deps);
	const activeVersion = day.program?.versionId ?? null;

	// All or nothing with the run's start: a busy send leaves the conversation as it was.
	const begun = await inTransaction(deps, async (deps) => {
		let preamble: BetaUserMessageParam['content'] | undefined;
		/** When the previous turn ended: decisions after it are this turn's news. */
		let since: Date | null = null;
		if (!(await findOwnerMessage(ownerId, input.clientMessageId, deps))) {
			let summary: string | null = null;
			let opens = true;
			if (input.threadId) {
				const { thread, rows } = await getTranscript(ownerId, input.threadId, deps);
				if (thread.archived) throw new CoachArchivedError();
				since = thread.lastMessageAt;
				const rolled = await rollover({
					ownerId,
					thread,
					promptVersion: version,
					programVersionId: activeVersion,
					deps
				});
				summary = rolled.summary;
				opens = rolled.thread.segment !== thread.segment || rows.length === 0;
			}
			if (opens)
				preamble = segmentPreamble(
					await loadMemory({ ownerId, today: day.today, deps }),
					summary
				).content;
		}
		const owner = await startOwnerTurn(
			ownerId,
			{
				threadId: input.threadId,
				clientMessageId: input.clientMessageId,
				text: input.text,
				entry: input.entry ?? null,
				segment: { promptVersion: version, programVersionId: activeVersion },
				preamble: preamble as TurnStep['assistant']['content'] | undefined
			},
			deps
		);
		const threadId = owner.thread.id;
		const { thread, rows } = await getTranscript(ownerId, threadId, deps);
		const at = rows.findIndex((row) => row.seq === owner.message.seq);
		const after = at < 0 ? null : rows.slice(at + 1);
		if (
			owner.duplicate &&
			(after === null ||
				after.some((row) => row.kind === 'owner_message') ||
				after.at(-1)?.kind === 'assistant')
		)
			return { answer: await storedAnswer(ownerId, threadId, owner.message.seq, deps) };
		const [first, ...transcript] = rows;
		if (first?.kind !== 'segment_preamble' || after === null)
			throw new CoachTranscriptError('a segment opens with its memory preamble');
		// A retry runs on the stored message, never on what the retry sent.
		const ownerText = rows[at]!.content as string;
		const lookup = directIntent(ownerText);
		const model = {
			provider: provider.status === 'ready' ? provider.provider.name : 'none',
			model: COACH_MODEL,
			effort: CHAT_EFFORT
		};
		const started = await startRun(
			ownerId,
			{
				threadId,
				triggerMessageId: owner.message.id,
				kind: 'turn',
				...(lookup ? DIRECT_RUN : model),
				promptVersion: version
			},
			deps
		);
		const decided = since ? await listDecidedSince(ownerId, since, deps) : [];
		return { owner, thread, first, transcript, after, ownerText, lookup, started, decided };
	});
	if (begun.answer !== undefined) {
		// Answered already: the client shows the stored answer.
		emit({ type: 'answer_completed', messageId: begun.answer });
		return 'completed';
	}
	const { owner, thread, first, transcript, after, ownerText, lookup, started, decided } = begun;
	const threadId = owner.thread.id;
	let contextPending = !after.some((row) => row.kind === 'context');
	const runId = (run.id = started.id);
	emit({ type: 'run_started', threadId, runId, messageId: owner.message.id });
	const startedAt = Date.now();
	let ttftMs: number | null = null;
	const end = async (status: RunEnd, error: string | null = null) => {
		await finishRun(ownerId, runId, { status, error, ttftMs }, deps);
		return status;
	};

	const entry = input.entry ?? null;
	const pain = detectPain(ownerText);
	const facts: TurnFacts = {
		date: day.today,
		localTime: day.localTime,
		timeZone: day.timeZone,
		todaysSessions: day.program?.todaysSessions ?? [],
		week:
			day.program?.week != null
				? weekSummary(
						{
							...day.program.week,
							versionId: day.program.versionId,
							versionNumber: day.program.versionNumber,
							segmentVersionId: thread.segmentProgramVersionId
						},
						day.today
					)
				: null,
		entry,
		painMode: pain.reported,
		decidedProposals: decided
	};
	const context = turnContext(facts);
	const opening = first.content as BetaUserMessageParam['content'];
	const answer = answerStream(
		{
			painMode: facts.painMode,
			area: pain.area ?? null,
			preamble: { role: 'user', content: opening },
			serverWritten: lookup !== null
		},
		(event) => {
			if (event.type === 'text_delta') ttftMs ??= Date.now() - startedAt;
			emit(event);
		}
	);
	const contextOnce = () => {
		const once = contextPending ? { context: context.content as TurnStep['context'] } : {};
		contextPending = false;
		return once;
	};
	/** Each change the output policy made, as a '_policy' row: every terminal path stores them. */
	const recordPolicy = (callIndex: number) =>
		recordToolCalls(
			ownerId,
			runId,
			answer.interventions().map((each, n): ToolCallInput => ({
				callIndex,
				toolUseId: `_policy_${n}`,
				name: '_policy',
				status: 'intervened',
				input: { block: each.block, reason: each.reason },
				output: each.detail,
				errorCode: null,
				truncated: false,
				startedAt: new Date(),
				durationMs: 0
			})),
			deps
		);
	/** Store the completed answer and say where it is. */
	const answered = async (content: TurnStep['assistant']['content'], callIndex: number) => {
		answer.finish(true);
		const blocks = answer.take();
		const stored =
			answer.interventions().length > 0 ? policedContent(content, answer.textOf(blocks)) : content;
		const { ids } = await appendTurnStep(
			ownerId,
			threadId,
			{ runId, ...contextOnce(), assistant: { content: stored, display: { blocks } } },
			deps
		);
		await recordPolicy(callIndex);
		emit({ type: 'answer_completed', messageId: ids.at(-1)! });
		return end('completed');
	};

	if (lookup) {
		const direct = await directAnswer({ ownerId, intent: lookup, facts, deps });
		answer.text(direct);
		return answered([{ type: 'text', text: direct }], 0);
	}
	if (provider.status === 'unavailable') {
		emit({ type: 'error', kind: 'unavailable', reason: provider.reason });
		return end('failed', 'unavailable');
	}
	if ((await spentToday(ownerId, deps)) >= DAILY_LIMITS.costMicros) {
		emit({ type: 'error', kind: 'budget' });
		return end('budget_exhausted', 'daily_cap');
	}

	const deadlineAt = options.deadlineAt ?? Date.now() + TURN_LIMITS.turnMs;
	const request = buildModelRequest({
		preamble: { role: 'user', content: opening },
		transcript: transcript.map(
			(row) => ({ role: row.role, content: row.content }) as BetaMessageParam
		),
		context: contextPending ? context : null,
		tools: definitions
	});
	const hooks: Partial<TurnHooks> = {
		onText: (text) => answer.text(text),
		onFallback: () => answer.fallback(),
		onReissue: () => answer.reissue(),
		onActivity: emit,
		onCall: async ({ refusalCategory, ...call }) => {
			answer.callEnded();
			await recordModelCall(
				ownerId,
				runId,
				{ ...call, stopDetails: { category: refusalCategory } },
				deps
			);
		},
		persistStep: async (step) => {
			const blocks = answer.take();
			await appendTurnStep(
				ownerId,
				threadId,
				{
					runId,
					...contextOnce(),
					assistant: {
						content: step.assistant.content as unknown as TurnStep['assistant']['content'],
						display: blocks.length > 0 ? { blocks } : null
					},
					toolResults: step.results.content as unknown as TurnStep['toolResults']
				},
				deps
			);
			const uses = new Map(
				(step.assistant.content as BetaToolUseBlock[])
					.filter((block) => block.type === 'tool_use')
					.map((block) => [block.id, block.input])
			);
			await recordToolCalls(
				ownerId,
				runId,
				step.outcomes.map((outcome) => ({
					callIndex: step.callIndex,
					toolUseId: outcome.toolUseId,
					name: outcome.name,
					status: outcome.status,
					input: uses.get(outcome.toolUseId) ?? null,
					output: outcome.output,
					errorCode: outcome.error?.code ?? null,
					truncated: outcome.truncated,
					proposalId: (proposalOf(outcome) as { id?: string } | null)?.id ?? null,
					startedAt: new Date(outcome.startedAt),
					durationMs: outcome.durationMs
				})),
				deps
			);
			answer.observe(step.outcomes);
			for (const outcome of step.outcomes) {
				const event = proposalOf(outcome);
				if (event) emit(event);
			}
		},
		cancelRequested: () => isCancelRequested(ownerId, runId, deps)
	};
	const result = await runLoop({
		provider: provider.provider,
		request,
		context: toolContext({
			session: { ownerId },
			message: { threadId, runId, text: ownerText, entry },
			day: { today: day.today, timeZone: day.timeZone },
			runtime: toolRuntime(deps),
			signal: input.signal,
			deadlineAt,
			matchExercise: day.matchExercise
		}),
		signal: input.signal,
		hooks,
		tools,
		deadlineAt
	});

	let outcome = result.outcome;
	// Stop drops the stream as well as setting the flag: the owner stopped it.
	if (outcome === 'interrupted' && (await isCancelRequested(ownerId, runId, deps)))
		outcome = 'cancelled';
	if (outcome === 'completed' && result.answer && result.answer.content.length > 0)
		return answered(
			result.answer.content as unknown as TurnStep['assistant']['content'],
			result.usage.calls - 1
		);
	if (outcome === 'completed') outcome = 'failed';

	// Not answered: what was shown is kept for the screen only, never replayed.
	const pending = answer.pending();
	answer.finish(false);
	const blocks = answer.take();
	const text = answer.interventions().length > 0 ? answer.textOf(blocks) : pending;
	const status: MessageStatus =
		outcome === 'cancelled' ? 'stopped' : outcome === 'interrupted' ? 'interrupted' : 'failed';
	if (text.trim() !== '' || blocks.length > 0) {
		const partial = { runId, content: [{ type: 'text', text }], display: { blocks }, status };
		await appendDisplayOnly(ownerId, threadId, partial, deps);
	}
	await recordPolicy(Math.max(0, result.usage.calls - 1));
	emit({ type: 'error', kind: TURN_ERROR[outcome] });
	return end(outcome, result.error?.kind ?? (outcome === 'failed' ? 'empty_answer' : null));
}
