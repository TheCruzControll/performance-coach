/**
 * The coach's manual tool loop (ADR 0013, the coach agent loop): one turn's model calls and tool
 * steps, over any LlmProvider, so the MockProvider drives exactly the loop production runs.
 *
 * One AbortSignal stops everything: it joins the caller's signal (the client left), the turn
 * deadline (TURN_LIMITS.turnMs) and the run's stored cancel flag, which is asked between steps.
 *
 * Each call streams (text to hooks.onText; thinking, progress blocks included, never), takes the
 * final message, updates the budget, and reads stop_reason before any content (the claude-api
 * skill's tool-use rules):
 * - refusal: no tool runs, even one the message holds (a refusal can cut a tool input short)
 * - max_tokens: a truncated tool_use never runs; the call is sent once more with more room, and
 *   otherwise the turn ends budget_exhausted
 * - pause_turn: the same request is sent again (see PAUSED below)
 * - model_context_window_exceeded: ends the turn budget_exhausted; more room would not help, and
 *   a tool_use in it may be cut short
 * - tool_use: the tools run (execute.ts: per-tool deadlines, three at a time on the pool, one at
 *   a time when ctx.serialTools says the services hold a transaction), the step is stored with
 *   all its results, then the chips say done
 * - anything else ends the turn with the message as its answer
 * A streamed tool input that is not JSON (invalid_tool_json) is sent again, at most twice. A
 * cancel while tools run answers each pending tool_use with an is_error 'cancelled' result, so the
 * stored step stays a valid request.
 *
 * The loop never touches the database: it stores through hooks.persistStep and hooks.onCall, and
 * its tools reach the services through ctx.deps. Logs carry ids and counts, never text.
 */
import type {
	BetaContentBlockParam,
	BetaMessage,
	BetaMessageParam,
	BetaStopReason,
	BetaToolUseBlock,
	BetaUsage
} from '@anthropic-ai/sdk/resources/beta/messages';
import { activityLabel } from '../../domain/coach/activity.ts';
import {
	blockingLimit,
	TURN_BUDGET_START,
	TURN_LIMITS,
	turnBudget,
	type TurnBudget,
	type TurnLimit,
	type TurnLimits
} from '../../domain/coach/budgets.ts';
import {
	capCostMicros,
	costMicros,
	usageTotals,
	type ModelUsage,
	type TokenUsage,
	type UsageIteration
} from '../../domain/coach/pricing.ts';
import type { ToolName } from '../../domain/coach/tools.ts';
import type { RunStatus } from '../../domain/coach/vocabulary.ts';
import { logger } from '../observability/logger.ts';
import { withDefaults, type LoopStep, type ModelCallRecord, type TurnHooks } from './hooks.ts';
import {
	CoachProviderError,
	type LlmProvider,
	type ModelRequest,
	type ModelResult
} from './provider/types.ts';
import type { ToolContext } from './tools/context.ts';
import type { CoachTool } from './tools/define.ts';
import { executeToolCalls } from './tools/execute.ts';

/** How many times a call whose streamed tool input is not JSON is sent again (ADR 0013). */
export const INVALID_JSON_REISSUES = 2;

/** A call cut off at max_tokens inside a tool_use is sent once more with this many times the room. */
export const MAX_TOKENS_REISSUE_FACTOR = 2;

/**
 * Owner decision (open question "Cancel on disconnect"): how long a turn keeps running after the
 * client leaves (the iPhone backgrounds mid-answer). 0 interrupts it at once and the answer shows
 * 'interrupted' with Retry; a grace period would let a quick return find it finished.
 */
export const DISCONNECT_GRACE_MS = 0;

/*
 * PAUSED: the API resumes a paused turn when the request ends with the paused assistant message,
 * which it recognises by a trailing server tool call. The coach sends no server tools, so such a
 * message would end in text, which Opus 5.5 refuses as a prefill (validate.ts). The loop sends
 * the same request again instead; the chat-call cap bounds how often.
 */

/** How a turn's loop ended: the run statuses a loop can reach. */
export type LoopOutcome = Extract<
	RunStatus,
	| 'completed'
	| 'refused'
	| 'budget_exhausted'
	| 'cancelled'
	| 'interrupted'
	| 'timed_out'
	| 'failed'
>;

/** What stopped the turn's signal: the client left, Stop, or the deadline. */
export type StopCause = 'disconnected' | 'cancelled' | 'deadline';

export interface TurnUsage extends TokenUsage {
	calls: number;
	/** Null when some call's model is not in PRICING. */
	costMicros: number | null;
	capCostMicros: number;
	budget: TurnBudget;
}

export interface LoopResult {
	outcome: LoopOutcome;
	/** The last finished call's stop reason; null when none finished. */
	stopReason: BetaStopReason | null;
	usage: TurnUsage;
	/** Every tool step, in order, each already passed to persistStep. */
	steps: LoopStep[];
	/**
	 * The last call's message when it answers the turn (end_turn), declines it (refusal) or was cut
	 * off (max_tokens); null otherwise. The turn parses and stores it; the loop does not.
	 */
	answer: BetaMessage | null;
	/** The turn limit that ended a budget_exhausted turn, when one did. */
	limit: TurnLimit | null;
	stopCause: StopCause | null;
	/** The provider's error for a failed turn. */
	error: CoachProviderError | null;
}

export interface LoopInput<Deps> {
	provider: LlmProvider;
	/** The turn's first request (prompt/layout.ts); each step's messages are appended to it. */
	request: ModelRequest;
	/** The tools' context; the loop replaces its signal and deadline with the turn's. */
	context: ToolContext<Deps>;
	/** The caller's signal: the request's, which aborts when the client leaves. */
	signal: AbortSignal;
	hooks?: Partial<TurnHooks>;
	/** The registry's tools by default. */
	tools?: readonly CoachTool<Deps>[];
	limits?: TurnLimits;
	disconnectGraceMs?: number;
	/**
	 * When the turn must stop by the endpoint's clock, which started before the loop (the run, the
	 * turn facts, a rollover). The loop stops at this or TURN_LIMITS.turnMs after its own start,
	 * whichever comes first.
	 */
	deadlineAt?: number;
}

const OUTCOME_OF: Record<StopCause, LoopOutcome> = {
	disconnected: 'interrupted',
	cancelled: 'cancelled',
	deadline: 'timed_out'
};

const ZERO_USAGE: ModelUsage = Object.freeze({
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0
});

/** The API's usage in the agent's terms; iterations price each attempt at its own model. */
export function modelUsage(usage: BetaUsage, model: string): ModelUsage {
	const tokens = (each: {
		input_tokens: number;
		output_tokens: number;
		cache_read_input_tokens?: number | null;
		cache_creation_input_tokens?: number | null;
	}): TokenUsage => ({
		inputTokens: each.input_tokens,
		outputTokens: each.output_tokens,
		cacheReadTokens: each.cache_read_input_tokens ?? 0,
		cacheWriteTokens: each.cache_creation_input_tokens ?? 0
	});
	// The coach uses neither compaction nor the advisor, so only these two attempt kinds occur.
	const iterations = (usage.iterations ?? []).flatMap((each): UsageIteration[] =>
		each.type === 'message' || each.type === 'fallback_message'
			? [{ ...tokens(each), kind: each.type, model: each.model ?? model }]
			: []
	);
	return { ...tokens(usage), ...(iterations.length > 0 && { iterations }) };
}

type Called =
	| { ok: true; result: ModelResult; record: ModelCallRecord }
	| { ok: false; error: CoachProviderError; record: ModelCallRecord };

export async function runLoop<Deps>(input: LoopInput<Deps>): Promise<LoopResult> {
	const { provider, request } = input;
	const hooks = withDefaults(input.hooks);
	const limits = input.limits ?? TURN_LIMITS;
	const grace = input.disconnectGraceMs ?? DISCONNECT_GRACE_MS;
	const deadlineAt = Math.min(input.deadlineAt ?? Infinity, Date.now() + limits.turnMs);

	const controller = new AbortController();
	let stopCause: StopCause | null = null;
	const stop = (cause: StopCause) => {
		if (controller.signal.aborted) return;
		stopCause = cause;
		const name = cause === 'deadline' ? 'TimeoutError' : 'AbortError';
		controller.abort(new DOMException(`The coach turn stopped: ${cause}`, name));
	};
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	const onDisconnect = () => {
		if (grace > 0) graceTimer ??= setTimeout(() => stop('disconnected'), grace);
		else stop('disconnected');
	};
	const deadline = setTimeout(() => stop('deadline'), Math.max(0, deadlineAt - Date.now()));
	if (input.signal.aborted) onDisconnect();
	else input.signal.addEventListener('abort', onDisconnect, { once: true });

	const ctx: ToolContext<Deps> = Object.freeze({
		...input.context,
		signal: controller.signal,
		deadlineAt
	});
	const messages: BetaMessageParam[] = [...request.messages];
	const steps: LoopStep[] = [];
	let budget = TURN_BUDGET_START;
	let totals: TokenUsage = { ...ZERO_USAGE };
	let cost: number | null = 0;
	let capCost = 0;
	let calls = 0;
	let stopReason: BetaStopReason | null = null;

	const finish = (
		outcome: LoopOutcome,
		extra: { answer?: BetaMessage; limit?: TurnLimit; error?: CoachProviderError } = {}
	): LoopResult => ({
		outcome,
		stopReason,
		usage: { ...totals, calls, costMicros: cost, capCostMicros: capCost, budget },
		steps,
		answer: extra.answer ?? null,
		limit: extra.limit ?? null,
		stopCause,
		error: extra.error ?? null
	});
	const stopped = async () => {
		if (!controller.signal.aborted && (await hooks.cancelRequested())) stop('cancelled');
		return stopCause;
	};

	const call = async (maxTokens: number): Promise<Called> => {
		const index = calls++;
		const startedAt = Date.now();
		let ttftMs: number | null = null;
		// The usage the stream has reported so far: a call that fails mid-stream is still billed.
		let streamed: { usage: BetaUsage; model: string } | null = null;
		const body: ModelRequest = { ...request, max_tokens: maxTokens, messages: [...messages] };
		let outcome: { ok: true; result: ModelResult } | { ok: false; error: CoachProviderError };
		try {
			const stream = provider.stream(body, controller.signal);
			for await (const event of stream) {
				if (event.type === 'message_start')
					streamed = { usage: event.message.usage, model: event.message.model };
				if (event.type === 'message_delta' && streamed) {
					const { usage } = event;
					streamed.usage = {
						...streamed.usage,
						input_tokens: usage.input_tokens ?? streamed.usage.input_tokens,
						output_tokens: usage.output_tokens,
						cache_read_input_tokens:
							usage.cache_read_input_tokens ?? streamed.usage.cache_read_input_tokens,
						cache_creation_input_tokens:
							usage.cache_creation_input_tokens ?? streamed.usage.cache_creation_input_tokens,
						iterations: usage.iterations ?? streamed.usage.iterations
					};
				}
				if (event.type === 'content_block_start' && event.content_block.type === 'fallback')
					hooks.onFallback();
				if (event.type !== 'content_block_delta') continue;
				ttftMs ??= Date.now() - startedAt;
				if (event.delta.type === 'text_delta') hooks.onText(event.delta.text);
			}
			outcome = { ok: true, result: await stream.final() };
		} catch (error) {
			if (!(error instanceof CoachProviderError)) throw error;
			outcome = { ok: false, error };
		}
		const message = outcome.ok ? outcome.result.message : null;
		const billed = message ?? streamed;
		const usage = billed ? modelUsage(billed.usage, billed.model) : ZERO_USAGE;
		const record: ModelCallRecord = {
			index,
			requestId: outcome.ok ? outcome.result.requestId : null,
			model: message?.model ?? null,
			stopReason: message?.stop_reason ?? null,
			refusalCategory: message?.stop_details?.category ?? null,
			usage,
			costMicros: billed ? costMicros(usage, billed.model) : 0,
			capCostMicros: billed ? capCostMicros(usage, billed.model) : 0,
			ttftMs,
			latencyMs: Date.now() - startedAt,
			error: outcome.ok ? null : outcome.error.kind
		};
		budget = turnBudget(budget, { kind: 'chat', usage }, limits);
		const used = usageTotals(usage);
		totals = {
			inputTokens: totals.inputTokens + used.inputTokens,
			outputTokens: totals.outputTokens + used.outputTokens,
			cacheReadTokens: totals.cacheReadTokens + used.cacheReadTokens,
			cacheWriteTokens: totals.cacheWriteTokens + used.cacheWriteTokens
		};
		cost = cost === null || record.costMicros === null ? null : cost + record.costMicros;
		capCost += record.capCostMicros;
		if (message) stopReason = message.stop_reason;
		logger.info('coach model call', {
			runId: ctx.runId,
			threadId: ctx.threadId,
			call: index,
			requestId: record.requestId,
			model: record.model,
			stopReason: record.stopReason,
			refusalCategory: record.refusalCategory,
			...used,
			ttftMs,
			latencyMs: record.latencyMs,
			error: record.error
		});
		await hooks.onCall(record);
		return { ...outcome, record };
	};

	try {
		let maxTokens = request.max_tokens;
		let tokensReissued = false;
		let jsonReissues = 0;
		for (;;) {
			const cause = await stopped();
			if (cause) return finish(OUTCOME_OF[cause]);
			const limit = blockingLimit(budget, 'chat', limits);
			if (limit) return finish('budget_exhausted', { limit });

			const called = await call(maxTokens);
			if (!called.ok) {
				if (stopCause) return finish(OUTCOME_OF[stopCause]);
				if (called.error.kind === 'invalid_tool_json' && jsonReissues < INVALID_JSON_REISSUES) {
					jsonReissues += 1;
					hooks.onReissue('invalid_tool_json');
					continue;
				}
				return finish('failed', { error: called.error });
			}
			const { message } = called.result;
			const toolUses = message.content.filter(
				(block): block is BetaToolUseBlock => block.type === 'tool_use'
			);

			if (message.stop_reason === 'refusal') return finish('refused', { answer: message });
			if (message.stop_reason === 'max_tokens') {
				if (toolUses.length === 0 || tokensReissued)
					return finish('budget_exhausted', { answer: message });
				tokensReissued = true;
				maxTokens = request.max_tokens * MAX_TOKENS_REISSUE_FACTOR;
				hooks.onReissue('max_tokens');
				continue;
			}
			if (message.stop_reason === 'model_context_window_exceeded')
				return finish('budget_exhausted', { answer: message });
			if (message.stop_reason === 'pause_turn') {
				hooks.onReissue('pause_turn');
				continue;
			}
			if (message.stop_reason !== 'tool_use' || toolUses.length === 0)
				return finish('completed', { answer: message });
			// No further call could read these results, so the tools never run.
			if (budget.exhausted) return finish('budget_exhausted', { limit: budget.exhausted });

			for (const use of toolUses)
				hooks.onActivity({
					type: 'activity',
					id: use.id,
					tool: use.name,
					state: 'running',
					label: activityLabel(use.name as ToolName, use.input).running
				});
			const executed = await executeToolCalls(toolUses, ctx, { tools: input.tools, limits });
			const step: LoopStep = {
				index: steps.length,
				// Verbatim: Opus 5.5 ties thinking blocks to the exact history that produced them.
				assistant: { role: 'assistant', content: message.content as BetaContentBlockParam[] },
				results: executed.message,
				outcomes: executed.outcomes,
				callIndex: called.record.index
			};
			await hooks.persistStep(step);
			steps.push(step);
			messages.push(step.assistant, step.results);
			for (const [index, outcome] of executed.outcomes.entries()) {
				const words = activityLabel(
					outcome.name as ToolName,
					toolUses[index]!.input,
					outcome.output
				);
				const done = outcome.status === 'succeeded';
				hooks.onActivity({
					type: 'activity',
					id: outcome.toolUseId,
					tool: outcome.name,
					state: done ? 'done' : 'failed',
					label: done ? words.done : words.failed
				});
			}
			maxTokens = request.max_tokens;
			tokensReissued = false;
			jsonReissues = 0;
		}
	} finally {
		clearTimeout(deadline);
		clearTimeout(graceTimer);
		input.signal.removeEventListener('abort', onDisconnect);
	}
}
