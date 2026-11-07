/**
 * The Anthropic provider on the real SDK, offline: the SDK's fetch is a fake that records each
 * request and answers with hand-written SSE (tests/fixtures/anthropic/*.sse) or an API error
 * body (http-*.json). No call leaves the machine.
 */
import { readFileSync } from 'node:fs';
import * as Sdk from '@anthropic-ai/sdk';
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import { modelUsage } from '../orchestrator.ts';
import { buildModelRequest } from '../prompt/layout.ts';
import { defineTool } from '../tools/define.ts';
import { toStrictJsonSchema } from '../tools/schema.ts';
import {
	AnthropicProvider,
	FALLBACK_BETA,
	mapError,
	MAX_RETRIES,
	type AnthropicProviderOptions
} from './anthropic.ts';
import { COACH_MODEL, CoachProviderError, type ModelRequest } from './types.ts';
import { validateRequest } from './validate.ts';

const KEY = 'sk-ant-api03-test-key-0123456789abcdefghij';
const FIXTURES = new URL('../../../../../tests/fixtures/anthropic/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES), 'utf8');

interface Recorded {
	url: URL;
	method: string;
	headers: Headers;
	body: Record<string, unknown>;
}

type Reply = (init: RequestInit) => Response | Promise<Response>;

const sse =
	(name: string): Reply =>
	() =>
		new Response(fixture(name), {
			status: 200,
			headers: { 'content-type': 'text/event-stream', 'request-id': `req_${name}` }
		});

const http =
	(
		status: number,
		headers: Record<string, string> = {},
		body = fixture(`http-${status}.json`)
	): Reply =>
	() =>
		new Response(body, {
			status,
			headers: { 'content-type': 'application/json', 'request-id': `req_${status}`, ...headers }
		});

/** A fetch that records every request and answers with the replies in turn (the last repeats). */
function fakeFetch(...replies: Reply[]) {
	const calls: Recorded[] = [];
	const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
		const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
		calls.push({
			url: new URL(String(input instanceof Request ? input.url : input)),
			method: init.method ?? 'GET',
			headers: new Headers(init.headers),
			body
		});
		return replies[Math.min(calls.length, replies.length) - 1]!(init);
	};
	return { fetch: fetch as typeof globalThis.fetch, calls };
}

function provider(replies: Reply[], options: AnthropicProviderOptions = {}) {
	const fake = fakeFetch(...replies);
	return {
		provider: new AnthropicProvider({ apiKey: KEY, fetch: fake.fetch, maxRetries: 0, ...options }),
		calls: fake.calls
	};
}

const tool = (name: 'get_exercise_history' | 'get_current_training_week') =>
	defineTool({
		name,
		description: `The ${name} tool.`,
		input: z.object({ exercise_id: z.optional(z.string()), limit: z.optional(z.int()) }),
		output: z.object({ count: z.int() }),
		run: async () => ({ count: 0 })
	}).definition;

/** A chat request as the layout builds it: strict tools, the frozen system prompt, caching. */
const request = (): ModelRequest =>
	buildModelRequest({
		preamble: { role: 'user', content: [{ type: 'text', text: 'Memory snapshot (data): {}' }] },
		transcript: [],
		context: { role: 'system', content: 'Turn context (data): {"date": "2026-11-02"}' },
		tools: [tool('get_current_training_week'), tool('get_exercise_history')]
	});

const signal = () => new AbortController().signal;

async function failure(promise: Promise<unknown>): Promise<CoachProviderError> {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught
	);
	expect(error).toBeInstanceOf(CoachProviderError);
	return error as CoachProviderError;
}

describe('loading', () => {
	it('loads the SDK only by a dynamic import, on the first call', () => {
		const source = readFileSync(new URL('./anthropic.ts', import.meta.url), 'utf8');
		expect(source).not.toMatch(/^import (?!type )[^;]*'@anthropic-ai\//m);
		expect(source).toContain("import('@anthropic-ai/sdk')");
	});
});

describe('the request', () => {
	it('uses the SDK’s 2026-10-21 version and Bearer auth, with no x-api-key', async () => {
		const { provider: anthropic, calls } = provider([sse('text.sse')]);
		await anthropic.stream(request(), signal()).final();
		const [call] = calls;
		expect(call!.headers.get('anthropic-version')).toBe('2026-10-21');
		expect(call!.headers.get('authorization')).toBe(`Bearer ${KEY}`);
		expect(call!.headers.has('x-api-key')).toBe(false);
		expect(call!.headers.get('anthropic-beta')).toBe(FALLBACK_BETA);
		expect(`${call!.method} ${call!.url.pathname}`).toBe('POST /v1/messages');
	});

	it('sends the model, explicit effort, strict eager tools, caching and the fallback, and nothing else', async () => {
		const { provider: anthropic, calls } = provider([sse('text.sse')]);
		const sent = request();
		await anthropic.stream(sent, signal()).final();
		const { body } = calls[0]!;

		expect(body).toEqual({ ...sent, model: COACH_MODEL, fallbacks: 'default', stream: true });
		expect(body.model).toBe('claude-opus-5-5');
		for (const field of ['thinking', 'tool_choice', 'temperature', 'top_p', 'top_k', 'betas'])
			expect(body, field).not.toHaveProperty(field);
		expect(JSON.stringify(body)).not.toContain('budget_tokens');
		expect(body.output_config).toEqual({ effort: 'medium' });
		expect(body.cache_control).toEqual({ type: 'ephemeral' });
		const tools = body.tools as { strict?: boolean; eager_input_streaming?: boolean }[];
		expect(tools.length).toBeGreaterThan(0);
		for (const tool of tools)
			expect(tool).toMatchObject({ strict: true, eager_input_streaming: true });
		expect((body.messages as { role: string }[]).at(-1)!.role).not.toBe('assistant');
		expect(validateRequest(body as unknown as ModelRequest)).toEqual([]);
	});

	it('refuses, without sending it, a request the API would refuse', async () => {
		const { provider: anthropic, calls } = provider([sse('text.sse')]);
		const sampled = {
			...request(),
			temperature: 0.2,
			thinking: { type: 'disabled' }
		} as ModelRequest;
		const error = await failure(anthropic.stream(sampled, signal()).final());
		expect(error.kind).toBe('bad_request');
		expect(error.message).toMatch(/sampling at temperature; thinking at thinking/);
		const prefilled = { ...request() };
		prefilled.messages = [...prefilled.messages, { role: 'assistant', content: 'Sure' }];
		expect((await failure(anthropic.stream(prefilled, signal()).final())).kind).toBe('bad_request');
		expect(calls).toHaveLength(0);
	});

	it('retries a 5xx MAX_RETRIES times under the one signal, then fails', async () => {
		const { provider: anthropic, calls } = provider([http(500, { 'retry-after-ms': '1' })], {
			maxRetries: undefined
		});
		expect((await failure(anthropic.stream(request(), signal()).final())).kind).toBe(
			'server_error'
		);
		expect(calls).toHaveLength(MAX_RETRIES + 1);
	});

	it('counts tokens on the beta count endpoint, without max_tokens or streaming', async () => {
		const { provider: anthropic, calls } = provider([
			() => Response.json({ input_tokens: 2048 }, { headers: { 'request-id': 'req_count' } })
		]);
		const sent = request();
		expect(await anthropic.countTokens(sent, signal())).toBe(2048);
		const [call] = calls;
		expect(`${call!.method} ${call!.url.pathname}`).toBe('POST /v1/messages/count_tokens');
		const { max_tokens: _max, ...counted } = sent;
		expect(call!.body).toEqual({ ...counted, model: COACH_MODEL });
		expect(call!.headers.get('authorization')).toBe(`Bearer ${KEY}`);
	});
});

describe('the response', () => {
	it('streams the raw events and keeps the request id', async () => {
		const { provider: anthropic } = provider([sse('text.sse')]);
		const stream = anthropic.stream(request(), signal());
		const events: BetaRawMessageStreamEvent[] = [];
		for await (const event of stream) events.push(event);
		expect(events.map((event) => event.type)).toContain('content_block_delta');
		const { message, requestId } = await stream.final();
		expect(requestId).toBe('req_text.sse');
		expect(message.stop_reason).toBe('end_turn');
		expect(message.stop_details).toBeNull();
		expect(message.content).toEqual([
			{ type: 'text', text: 'You squatted 3 sets of 5 at 120 kg on Monday.', citations: null }
		]);
	});

	it('keeps an empty progress thinking block verbatim before parallel tool calls', async () => {
		const { provider: anthropic } = provider([sse('tool-use.sse')]);
		const { message } = await anthropic.stream(request(), signal()).final();
		expect(message.stop_reason).toBe('tool_use');
		expect(JSON.parse(JSON.stringify(message.content))).toEqual([
			{ type: 'thinking', thinking: '', signature: 'EqQBCkYIBxgCKkDprogress' },
			{
				type: 'tool_use',
				id: 'toolu_01History',
				name: 'get_exercise_history',
				input: { exercise_id: 'ex_back_squat', limit: 5 }
			},
			{ type: 'tool_use', id: 'toolu_02Week', name: 'get_current_training_week', input: {} }
		]);
	});

	it('reads stop_details on a refusal', async () => {
		const { provider: anthropic } = provider([sse('refusal.sse')]);
		const { message } = await anthropic.stream(request(), signal()).final();
		expect(message.stop_reason).toBe('refusal');
		expect(message.stop_details).toMatchObject({
			type: 'refusal',
			category: 'cyber',
			explanation: 'The request was declined.'
		});
	});

	it.each([
		['max-tokens.sse', 'max_tokens'],
		['pause-turn.sse', 'pause_turn']
	])('maps %s to %s, with no stop_details', async (name, reason) => {
		const { provider: anthropic } = provider([sse(name)]);
		const { message } = await anthropic.stream(request(), signal()).final();
		expect(message.stop_reason).toBe(reason);
		expect(message.stop_details).toBeNull();
	});

	it('drops stop_details on any stop reason but a refusal', async () => {
		const details = JSON.stringify({ type: 'refusal', category: 'bio', explanation: 'x' });
		const { provider: anthropic } = provider([
			() =>
				new Response(
					fixture('pause-turn.sse').replace(
						'"stop_reason":"pause_turn","stop_sequence":null,"stop_details":null',
						`"stop_reason":"pause_turn","stop_sequence":null,"stop_details":${details}`
					),
					{ headers: { 'content-type': 'text/event-stream' } }
				)
		]);
		const { message } = await anthropic.stream(request(), signal()).final();
		expect(message.stop_reason).toBe('pause_turn');
		expect(message.stop_details).toBeNull();
	});

	it('keeps a fallback block verbatim and takes the served model from usage.iterations', async () => {
		const { provider: anthropic } = provider([sse('fallback.sse')]);
		const { message } = await anthropic.stream(request(), signal()).final();
		expect(message.content.map((block) => block.type)).toEqual(['text', 'fallback', 'text']);
		expect(message.content[1]).toEqual({
			type: 'fallback',
			from: { model: 'claude-opus-5-5' },
			to: { model: 'claude-opus-5' },
			trigger: { type: 'refusal', category: 'cyber' }
		});
		expect(message.model).toBe('claude-opus-5');
		expect(modelUsage(message.usage, message.model).iterations).toEqual([
			expect.objectContaining({ kind: 'message', model: 'claude-opus-5-5', outputTokens: 6 }),
			expect.objectContaining({
				kind: 'fallback_message',
				model: 'claude-opus-5',
				outputTokens: 22
			})
		]);
	});
});

describe('errors', () => {
	it.each([
		[400, 'bad_request'],
		[401, 'auth'],
		[402, 'auth'],
		[403, 'auth'],
		[429, 'rate_limited'],
		[500, 'server_error'],
		[529, 'overloaded']
	] as const)('maps HTTP %i to %s', async (status, kind) => {
		const { provider: anthropic } = provider([http(status)]);
		const error = await failure(anthropic.stream(request(), signal()).final());
		expect(error.kind).toBe(kind);
		expect(error.message).toContain(`status ${status}`);
		expect(error.message).toContain(`request req_${status}`);
	});

	it('keeps the API’s reason for a refused request', async () => {
		const { provider: anthropic } = provider([http(400)]);
		const error = await failure(anthropic.stream(request(), signal()).final());
		expect(error.message).toContain('temperature: Extra inputs are not permitted');
	});

	it.each([
		[{ 'retry-after': '7' }, 7000],
		[{ 'retry-after-ms': '1500', 'retry-after': '7' }, 1500],
		[{}, null]
	])('reads a 429’s wait from %o', async (headers, wait) => {
		const { provider: anthropic } = provider([http(429, headers)]);
		const error = await failure(anthropic.stream(request(), signal()).final());
		expect(error.retryAfterMs).toBe(wait);
	});

	it('maps an overloaded error event mid-stream, after the events before it', async () => {
		const { provider: anthropic } = provider([sse('overloaded-mid-stream.sse')]);
		const stream = anthropic.stream(request(), signal());
		const seen: string[] = [];
		const error = await failure(
			(async () => {
				for await (const event of stream) seen.push(event.type);
			})()
		);
		expect(error.kind).toBe('overloaded');
		expect(seen).toContain('content_block_delta');
		expect((await failure(stream.final())).kind).toBe('overloaded');
	});

	it('maps a connection failure', async () => {
		const { provider: anthropic } = provider([() => Promise.reject(new TypeError('fetch failed'))]);
		expect((await failure(anthropic.stream(request(), signal()).final())).kind).toBe('connection');
	});

	it('maps an eager tool input that is not JSON to invalid_tool_json', async () => {
		const { provider: anthropic } = provider([sse('tool-json-broken.sse')]);
		expect((await failure(anthropic.stream(request(), signal()).final())).kind).toBe(
			'invalid_tool_json'
		);
	});

	it('counts only the SDK’s JSON error as invalid tool JSON', () => {
		const other = (error: unknown) => mapError(Sdk, error, undefined, KEY).kind;
		expect(other(new Sdk.AnthropicError('Unable to parse tool parameter JSON from model. x'))).toBe(
			'invalid_tool_json'
		);
		expect(other(new SyntaxError('Unexpected token } in JSON'))).toBe('server_error');
		expect(other(new Sdk.AnthropicError('stream ended without producing a Message'))).toBe(
			'server_error'
		);
	});

	it('maps an abort before the call, and one mid-stream', async () => {
		const before = new AbortController();
		before.abort();
		const { provider: idle, calls } = provider([sse('text.sse')]);
		expect((await failure(idle.stream(request(), before.signal).final())).kind).toBe('aborted');
		expect(calls).toHaveLength(0);

		const during = new AbortController();
		const encoder = new TextEncoder();
		const { provider: anthropic } = provider([
			({ signal: fetchSignal }) =>
				new Response(
					new ReadableStream({
						start(controller) {
							// message_start only, then the server goes quiet until the fetch is aborted
							controller.enqueue(encoder.encode(fixture('text.sse').split('\n\n')[0] + '\n\n'));
							fetchSignal?.addEventListener('abort', () => controller.error(fetchSignal.reason));
						}
					}),
					{ headers: { 'content-type': 'text/event-stream' } }
				)
		]);
		const stream = anthropic.stream(request(), during.signal);
		const error = await failure(
			(async () => {
				for await (const event of stream) if (event.type === 'message_start') during.abort();
			})()
		);
		expect(error.kind).toBe('aborted');
	});

	it('never puts the key in an error, even when the API echoes it', async () => {
		const echo = JSON.stringify({
			type: 'error',
			error: { type: 'invalid_request_error', message: `x-api-key ${KEY} is malformed` }
		});
		for (const status of [400, 401, 429, 500]) {
			const { provider: anthropic } = provider([http(status, {}, echo)]);
			const error = await failure(anthropic.stream(request(), signal()).final());
			const seen = [error.message, String(error), JSON.stringify(error), String(error.cause ?? '')];
			for (const text of seen) expect(text, `${status}`).not.toContain(KEY);
		}
	});

	it('refuses to start without a key', () => {
		expect(() => new AnthropicProvider({ apiKey: '  ', fetch: fakeFetch().fetch })).toThrow(
			expect.objectContaining({ kind: 'auth' })
		);
	});
});

describe('structured()', () => {
	const schema = z.object({ title: z.string(), weeks: z.number() });
	const draft = (): Omit<ModelRequest, 'tools'> => {
		const { tools: _tools, ...rest } = request();
		return { ...rest, output_config: { effort: 'high' } };
	};

	it('sends the strict schema as output_config.format, with no tools, and parses the answer', async () => {
		const { provider: anthropic, calls } = provider([sse('structured.sse')]);
		const result = await anthropic.structured(draft(), schema, signal());
		expect(result.value).toEqual({ title: 'Deload week', weeks: 1 });
		const { body } = calls[0]!;
		expect(body).not.toHaveProperty('tools');
		expect(body.output_config).toEqual({
			effort: 'high',
			format: { type: 'json_schema', schema: toStrictJsonSchema(schema) }
		});
	});

	it('parses only the answer after a fallback, keeping the whole message for replay', async () => {
		const { provider: anthropic } = provider([sse('structured-fallback.sse')]);
		const result = await anthropic.structured(draft(), schema, signal());
		expect(result.value).toEqual({ title: 'Deload week', weeks: 1 });
		expect(result.message.content.map((block) => block.type)).toEqual(['text', 'fallback', 'text']);
	});

	it('rejects output that fails the schema', async () => {
		const { provider: anthropic } = provider([sse('structured.sse')]);
		const strict = z.object({ title: z.string(), weeks: z.number().check(z.minimum(2)) });
		const error = await failure(anthropic.structured(draft(), strict, signal()));
		expect(error.kind).toBe('invalid_output');
	});

	it('gives a null value when the answer stopped early', async () => {
		const { provider: anthropic } = provider([sse('max-tokens.sse')]);
		expect((await anthropic.structured(draft(), schema, signal())).value).toBeNull();
	});
});
