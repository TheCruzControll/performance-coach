/**
 * The Anthropic provider: LlmProvider over the pinned @anthropic-ai/sdk 1.x, as the claude-api
 * skill prescribes, and the only module that loads the SDK at runtime (by a dynamic import, on the
 * first call, so the SDK is read only on the server and only once the coach selects it).
 *
 * The client: the SDK's own API version (2026-10-21) and Bearer auth, no header overrides, the key
 * from the server environment, MAX_RETRIES retries under the caller's one AbortSignal, and an
 * injectable fetch (tests run it offline on recorded SSE).
 *
 * Every request is the agent's ModelRequest plus what this file owns: the model, the refusal
 * fallback beta with fallbacks 'default', and streaming. It carries no thinking (always adaptive
 * on Opus 5.5), no tool_choice (auto), no sampling and no prefill: validateRequest refuses the
 * body before it is sent, so nothing the 2026-10-21 API rejects ever leaves the server.
 *
 * Results are the API's message, content verbatim (empty progress thinking blocks, signatures and
 * fallback blocks included), the served model as the SDK labels it, the request id, and
 * stop_details only on a refusal. Errors become CoachProviderErrors (mapError), and never carry
 * the key.
 */
import type {
	BetaMessage,
	BetaRawMessageStreamEvent
} from '@anthropic-ai/sdk/resources/beta/messages';
import type * as SdkModule from '@anthropic-ai/sdk';
import * as z from 'zod/mini';
import { getEnv } from '../../env.ts';
import { toStrictJsonSchema } from '../tools/schema.ts';
import {
	COACH_MODEL,
	CoachProviderError,
	type LlmProvider,
	type ModelRequest,
	type ModelResult,
	type ModelStream,
	type ProviderErrorKind,
	type StructuredResult
} from './types.ts';
import { validateRequest } from './validate.ts';

type Sdk = typeof SdkModule;
type Client = InstanceType<Sdk['default']>;

/** Server-side refusal fallbacks: a declined request is retried on the default fallback model. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const FALLBACKS = 'default';
/** The SDK's retries of a 429, 5xx or connection failure, all under the call's one signal. */
export const MAX_RETRIES = 2;
/** The SDK's error for a streamed tool input that is not JSON: the only invalid_tool_json. */
const TOOL_JSON_ERROR = 'Unable to parse tool parameter JSON from model';

export interface AnthropicProviderOptions {
	/** By default ANTHROPIC_API_KEY from the server environment. */
	apiKey?: string;
	fetch?: typeof fetch;
	maxRetries?: number;
}

export class AnthropicProvider implements LlmProvider {
	readonly name = 'anthropic' as const;
	readonly model = COACH_MODEL;
	readonly #apiKey: string;
	readonly #options: AnthropicProviderOptions;
	#loaded: Promise<{ sdk: Sdk; client: Client }> | undefined;

	constructor(options: AnthropicProviderOptions = {}) {
		const apiKey = (options.apiKey ?? getEnv().ANTHROPIC_API_KEY ?? '').trim();
		if (!apiKey) throw new CoachProviderError('auth', 'ANTHROPIC_API_KEY is not set');
		this.#apiKey = apiKey;
		this.#options = options;
	}

	#load() {
		this.#loaded ??= import('@anthropic-ai/sdk').then((sdk) => ({
			sdk,
			client: new sdk.default({
				apiKey: this.#apiKey,
				maxRetries: this.#options.maxRetries ?? MAX_RETRIES,
				...(this.#options.fetch && { fetch: this.#options.fetch })
			})
		}));
		return this.#loaded;
	}

	stream(request: ModelRequest, signal: AbortSignal): ModelStream {
		const load = () => this.#load();
		const apiKey = this.#apiKey;
		return readOnce(async function* () {
			admit(request, signal);
			const { sdk, client } = await load();
			try {
				const stream = client.beta.messages.stream(
					{
						...request,
						model: COACH_MODEL,
						betas: [FALLBACK_BETA],
						fallbacks: FALLBACKS
					},
					{ signal }
				);
				for await (const event of stream) yield event;
				const message = await stream.finalMessage();
				return { message: normalised(message), requestId: stream.request_id ?? null };
			} catch (error) {
				throw mapError(sdk, error, signal, apiKey);
			}
		});
	}

	async structured<S extends z.ZodMiniType>(
		request: Omit<ModelRequest, 'tools'>,
		schema: S,
		signal: AbortSignal
	): Promise<StructuredResult<z.output<S>>> {
		const format = { type: 'json_schema' as const, schema: toStrictJsonSchema(schema) };
		const result = await this.stream(
			{ ...request, output_config: { ...request.output_config, format } } as ModelRequest,
			signal
		).final();
		if (result.message.stop_reason !== 'end_turn') return { ...result, value: null };
		// A fallback restarts the answer: only the text after the last one is the output.
		const { content } = result.message;
		const answer = content.slice(content.findLastIndex((block) => block.type === 'fallback') + 1);
		const text = answer.map((block) => (block.type === 'text' ? block.text : ''));
		let json: unknown;
		try {
			json = JSON.parse(text.join(''));
		} catch {
			throw new CoachProviderError('invalid_output', 'The structured output is not JSON');
		}
		const parsed = z.safeParse(schema, json);
		if (!parsed.success)
			throw new CoachProviderError('invalid_output', 'The structured output fails its schema', {
				cause: parsed.error
			});
		return { ...result, value: parsed.data };
	}

	async countTokens(request: ModelRequest, signal?: AbortSignal): Promise<number> {
		admit(request, signal);
		const { sdk, client } = await this.#load();
		const { max_tokens: _maxTokens, ...counted } = request;
		try {
			const count = await client.beta.messages.countTokens(
				{ ...counted, model: COACH_MODEL },
				{ signal }
			);
			return count.input_tokens;
		} catch (error) {
			throw mapError(sdk, error, signal, this.#apiKey);
		}
	}
}

/** The signal, then the API's rules: a request the API would refuse is never sent. */
function admit(request: ModelRequest, signal: AbortSignal | undefined) {
	if (signal?.aborted) throw new CoachProviderError('aborted', 'The call was aborted');
	const issues = validateRequest(request);
	if (issues.length > 0)
		throw new CoachProviderError(
			'bad_request',
			issues.map((issue) => `${issue.rule} at ${issue.at}`).join('; ')
		);
}

/**
 * The message as the loop reads it: stop_details only on a refusal, so the loop reads a refusal's
 * category then and only then. (The SDK already names the served model: a fallback block relabels
 * the message, as usage.iterations' last attempt does.)
 */
function normalised(message: BetaMessage): BetaMessage {
	return {
		...message,
		stop_details: message.stop_reason === 'refusal' ? message.stop_details : null
	};
}

/** The wait a 429 asked for: retry-after-ms, or retry-after in seconds or as an HTTP date. */
function retryAfterMs(headers: Headers | undefined): number | undefined {
	const ms = Number(headers?.get('retry-after-ms') ?? NaN);
	if (Number.isFinite(ms) && ms >= 0) return ms;
	const after = headers?.get('retry-after');
	if (!after) return undefined;
	const seconds = Number(after);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const at = Date.parse(after);
	return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** A mid-stream `error` event arrives as an APIError without a status, typed by its body. */
const STREAM_ERROR_KINDS: Record<string, ProviderErrorKind> = {
	overloaded_error: 'overloaded',
	rate_limit_error: 'rate_limited',
	api_error: 'server_error',
	authentication_error: 'auth',
	permission_error: 'auth',
	billing_error: 'auth',
	invalid_request_error: 'bad_request',
	request_too_large: 'bad_request'
};

function kindOf(sdk: Sdk, error: unknown, signal: AbortSignal | undefined): ProviderErrorKind {
	if (error instanceof sdk.APIUserAbortError || signal?.aborted) return 'aborted';
	if (error instanceof sdk.RateLimitError) return 'rate_limited';
	if (error instanceof sdk.InternalServerError)
		return error.status === 529 ? 'overloaded' : 'server_error';
	if (error instanceof sdk.APIConnectionError) return 'connection';
	if (error instanceof sdk.AuthenticationError || error instanceof sdk.PermissionDeniedError)
		return 'auth';
	if (error instanceof sdk.BadRequestError) return 'bad_request';
	if (error instanceof sdk.APIError) {
		if (error.status === 402) return 'auth';
		if (error.status === undefined) return STREAM_ERROR_KINDS[error.type ?? ''] ?? 'server_error';
		return error.status >= 500 ? 'server_error' : 'bad_request';
	}
	if (error instanceof sdk.AnthropicError && error.message.startsWith(TOOL_JSON_ERROR))
		return 'invalid_tool_json';
	return 'server_error';
}

/**
 * An SDK failure as a CoachProviderError, most specific class first. Its message names the kind,
 * the status, the API's error type and request id, and (for a refused request) the API's reason;
 * never the model's output, and never the key. The SDK error is not kept as the cause.
 */
export function mapError(
	sdk: Sdk,
	error: unknown,
	signal: AbortSignal | undefined,
	apiKey: string
): CoachProviderError {
	if (error instanceof CoachProviderError) return error;
	const kind = kindOf(sdk, error, signal);
	const api = error instanceof sdk.APIError ? error : null;
	const parts = [
		`Anthropic call failed: ${kind}`,
		api?.status !== undefined && `status ${api.status}`,
		api?.type && `type ${api.type}`,
		api?.requestID && `request ${api.requestID}`,
		kind === 'bad_request' && api?.apiMessage
	].filter(Boolean);
	const message = parts.join(', ').split(apiKey).join('[redacted]');
	return new CoachProviderError(kind, message, {
		retryAfterMs: kind === 'rate_limited' ? retryAfterMs(api?.headers) : undefined
	});
}

type Event = BetaRawMessageStreamEvent;

/**
 * A stream read once, by iterating it or by final(). Leaving the iteration early aborts the SDK's
 * stream and settles final() as aborted, as the MockProvider's does.
 */
function readOnce(source: () => AsyncGenerator<Event, ModelResult>): ModelStream {
	let started = false;
	const result = Promise.withResolvers<ModelResult>();
	result.promise.catch(() => {}); // the iteration reports the error to a caller that never calls final()

	async function* read(): AsyncGenerator<Event, void> {
		if (started) throw new Error('A model stream can be read once');
		started = true;
		const events = source();
		let next: IteratorResult<Event, ModelResult> | undefined;
		try {
			while (!(next = await events.next()).done) yield next.value;
			result.resolve(next.value);
		} catch (error) {
			result.reject(error);
			throw error;
		} finally {
			if (next && !next.done) await events.return(undefined as never); // left early: stop the SDK's stream
			result.reject(new CoachProviderError('aborted', 'The stream was left early'));
		}
	}

	return {
		[Symbol.asyncIterator]: read,
		async final() {
			if (!started) for await (const _event of read()); // drain
			return result.promise;
		}
	};
}
