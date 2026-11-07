/**
 * The seam between the agent and a model (ADR 0013, the coach agent loop): every coach call goes
 * through one LlmProvider, and the loop never knows which one. Requests and results are the Claude
 * API's own beta Messages types (@anthropic-ai/sdk 1.x, imported only as types), so the content
 * the loop stores is exactly what the API returned, and what it replays is what the API accepts
 * (validate.ts).
 *
 * Two providers implement it: the MockProvider (mock.ts), deterministic and offline, which every
 * test and keyless development use; and the Anthropic provider (anthropic-provider), the only file
 * that imports the SDK at runtime.
 */
import type {
	BetaCacheControlEphemeral,
	BetaMessage,
	BetaMessageParam,
	BetaOutputConfig,
	BetaRawMessageStreamEvent,
	BetaTextBlockParam,
	BetaTool
} from '@anthropic-ai/sdk/resources/beta/messages';
import type * as z from 'zod/mini';

/** The coach's model: the exact id, with no date suffix. */
export const COACH_MODEL = 'claude-opus-5-5';

export type Effort = NonNullable<BetaOutputConfig['effort']>;
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * One call as the agent builds it: the Messages API body without what the provider owns (the
 * model, streaming, betas and fallbacks). It has no thinking, tool_choice or sampling fields:
 * Opus 5.5 always thinks adaptively, tool choice stays auto, and 2026-10-21 refuses sampling.
 */
export interface ModelRequest {
	max_tokens: number;
	system?: string | BetaTextBlockParam[];
	tools?: BetaTool[];
	messages: BetaMessageParam[];
	/** Always explicit: Opus 5.5 defaults to medium, and the coach never relies on a default. */
	output_config: { effort: Effort };
	/** Top-level automatic caching: one breakpoint on the last cacheable block. */
	cache_control?: BetaCacheControlEphemeral;
}

/** A finished call: the message as the API assembled it, and the API's request id. */
export interface ModelResult {
	message: BetaMessage;
	requestId: string | null;
}

/**
 * A streaming call. Iterate it for the API's raw events (text, thinking, signature and tool-input
 * deltas), then call final(); or call final() alone. It can be read once. Errors are
 * CoachProviderErrors, thrown by the iteration and by final().
 */
export interface ModelStream extends AsyncIterable<BetaRawMessageStreamEvent> {
	final(): Promise<ModelResult>;
}

/** A structured-output call: `value` is the schema-checked output, or null when it stopped early. */
export interface StructuredResult<T> extends ModelResult {
	value: T | null;
}

export interface LlmProvider {
	readonly name: 'mock' | 'anthropic';
	readonly model: string;
	/** A chat call, streamed. */
	stream(request: ModelRequest, signal: AbortSignal): ModelStream;
	/**
	 * A call whose answer is JSON for `schema` (output_config.format), with no tools. Output that is
	 * not valid for the schema throws invalid_output; a refusal or max_tokens gives a null value.
	 */
	structured<S extends z.ZodMiniType>(
		request: Omit<ModelRequest, 'tools'>,
		schema: S,
		signal: AbortSignal
	): Promise<StructuredResult<z.output<S>>>;
	/** The request's input tokens, as the API counts them. */
	countTokens(request: ModelRequest, signal?: AbortSignal): Promise<number>;
}

/**
 * Why a call failed, mapped from the SDK's typed errors (most specific first) or raised by the
 * mock:
 * - bad_request: the API refused the request (400), or validateRequest did
 * - auth: the key is missing, wrong or not allowed (401, 403, 402)
 * - rate_limited: 429, with retryAfterMs when the API said how long
 * - overloaded: 529
 * - server_error: 500 and the other 5xx
 * - connection: the network failed or timed out
 * - aborted: the caller's signal fired
 * - invalid_tool_json: a streamed tool input that is not JSON (the SDK's JSON error only)
 * - invalid_output: a structured call's output that is not valid for its schema; `result` holds
 *   the completed response, so its billed usage is still recorded
 */
export const PROVIDER_ERROR_KINDS = [
	'bad_request',
	'auth',
	'rate_limited',
	'overloaded',
	'server_error',
	'connection',
	'aborted',
	'invalid_tool_json',
	'invalid_output'
] as const;
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

export class CoachProviderError extends Error {
	readonly kind: ProviderErrorKind;
	readonly retryAfterMs: number | null;
	readonly result: ModelResult | null;

	constructor(
		kind: ProviderErrorKind,
		message: string,
		options: { retryAfterMs?: number; cause?: unknown; result?: ModelResult } = {}
	) {
		super(message, { cause: options.cause });
		this.name = 'CoachProviderError';
		this.kind = kind;
		this.retryAfterMs = options.retryAfterMs ?? null;
		this.result = options.result ?? null;
	}
}
