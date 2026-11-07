/**
 * What the agent loop (orchestrator.ts) tells the rest of a turn, and the one thing it asks. The
 * turn (turn.ts) supplies them: the answer parser and the output policy read the text, the stream
 * sends the activity chips, the repositories store the calls and the steps, and the run's cancel
 * flag answers cancelRequested. Each hook has a no-op default, so the loop runs, and is tested,
 * with any subset of them.
 *
 * Hooks carry ids, counts and the API's own blocks; none is meant for logs (logs never hold
 * message text).
 */
import type {
	BetaAssistantMessageParam,
	BetaStopReason,
	BetaUserMessageParam
} from '@anthropic-ai/sdk/resources/beta/messages';
import type { CoachEvent } from '../../domain/coach/events.ts';
import type { ModelUsage } from '../../domain/coach/pricing.ts';
import type { ProviderErrorKind } from './provider/types.ts';
import type { ToolCallOutcome } from './tools/execute.ts';

export type ActivityEvent = Extract<CoachEvent, { type: 'activity' }>;

/** Why the loop sent a call again: whatever text the discarded call streamed is void. */
export type ReissueReason = 'max_tokens' | 'invalid_tool_json' | 'pause_turn';

/** One model call, as a model-call row stores it. */
export interface ModelCallRecord {
	/** The turn's calls in order, from 0, failed and re-issued ones included. */
	index: number;
	requestId: string | null;
	/** The model that served the call (a fallback's, when one took over); null if it failed. */
	model: string | null;
	stopReason: BetaStopReason | null;
	refusalCategory: string | null;
	usage: ModelUsage;
	/** Null when a model that ran is not in PRICING (pricing.ts). */
	costMicros: number | null;
	capCostMicros: number;
	/** Milliseconds to the first content delta; null when none arrived. */
	ttftMs: number | null;
	latencyMs: number;
	error: ProviderErrorKind | null;
}

/**
 * A tool step: the assistant message exactly as the provider returned it (thinking blocks,
 * signatures and fallback blocks included) and the one user message that answers every tool_use
 * in it. It is stored whole or not at all.
 */
export interface LoopStep {
	/** The turn's tool steps in order, from 0. */
	index: number;
	assistant: BetaAssistantMessageParam;
	results: BetaUserMessageParam;
	outcomes: readonly ToolCallOutcome[];
	/** The call that produced the assistant message (ModelCallRecord.index). */
	callIndex: number;
}

export interface TurnHooks {
	/** Visible text as it streams. Thinking (progress blocks included) never reaches it. */
	onText(text: string): void;
	/** A fallback model took over mid-call: the visible answer starts again (answer_reset). */
	onFallback(): void;
	/** The call that just streamed is sent again; its text is void. */
	onReissue(reason: ReissueReason): void;
	onActivity(event: ActivityEvent): void;
	/** After every call, before the loop acts on it. */
	onCall(call: ModelCallRecord): void | Promise<void>;
	/** After a step's tools, before their done chips: the step is stored atomically. */
	persistStep(step: LoopStep): void | Promise<void>;
	/**
	 * The run's stored cancel flag (Stop). Asked between steps only, never while tools run, so on
	 * a transaction it never queries a busy client (docs/architecture.md).
	 */
	cancelRequested(): boolean | Promise<boolean>;
}

export const NO_HOOKS: TurnHooks = Object.freeze({
	onText: () => {},
	onFallback: () => {},
	onReissue: () => {},
	onActivity: () => {},
	onCall: () => {},
	persistStep: () => {},
	cancelRequested: () => false
});

/** The given hooks, with a no-op for each one left out (or given as undefined). */
export const withDefaults = (hooks: Partial<TurnHooks> = {}): TurnHooks =>
	Object.freeze({
		...NO_HOOKS,
		...Object.fromEntries(Object.entries(hooks).filter(([, hook]) => hook !== undefined))
	});
