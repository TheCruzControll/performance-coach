/**
 * The MockProvider: a deterministic, offline Claude API, so every agent path can be tested without
 * a key, and keyless development has a coach. It refuses any request the 2026-10-21 API would
 * refuse (validate.ts), and answers the way Opus 5.5 does:
 * - a tool step is [an empty progress thinking block with a stub signature, tool_use…], with no
 *   visible text unless the script asks for it
 * - every stop reason the loop handles, a refusal's stop_details, and a server-side fallback as a
 *   fallback block with usage.iterations
 * - the SDK's raw stream events, chunked, with optional delays
 * - deterministic usage, with a cache read when an earlier request wrote the same prefix
 *
 * Scripts (mock-scripts/) say what to answer. The first script whose `matches` accepts the owner's
 * message plays (a script without one plays only when the test route forces it). Its steps answer
 * the turn's calls in order, picked by how many assistant messages the turn already has, so the
 * same conversation always gets the same bytes. Text and tool inputs can be computed from the
 * turn's earlier tool results.
 */
import { createHash } from 'node:crypto';
import type {
	BetaContentBlock,
	BetaIterationsUsage,
	BetaMessage,
	BetaMessageParam,
	BetaRawContentBlockDelta,
	BetaRawContentBlockStartEvent,
	BetaRawMessageStreamEvent,
	BetaRefusalStopDetails
} from '@anthropic-ai/sdk/resources/beta/messages';
import * as z from 'zod/mini';
import { mockOverrides, type MockOverrides } from './faults.ts';
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

/** The mock's tokenizer: one token per this many bytes of rendered prompt or answer. */
export const MOCK_BYTES_PER_TOKEN = 4;
/** Opus 5.5's minimum cacheable prefix: a shorter one is never written, so never read. */
export const MIN_CACHEABLE_TOKENS = 512;
/** How far back from a breakpoint the API looks for an earlier cache entry, in blocks. */
const CACHE_LOOKBACK = 20;
/** Where a fallback goes unless the script names a model ('default' routes by category). */
const FALLBACK_MODEL = 'claude-opus-5';
const CHUNK_CHARS = 16;

export type RefusalCategory = BetaRefusalStopDetails['category'];
export type MockStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'pause_turn' | 'refusal';

export interface MockToolResult {
	name: string;
	isError: boolean;
	/** The result's content, parsed when it is JSON. */
	content: unknown;
}

export interface MockContext {
	/** The owner's message the turn answers. */
	ownerText: string;
	/** The turn's tool results so far, oldest first. */
	results: readonly MockToolResult[];
	/** The latest result of a tool; it throws if the tool has not run this turn. */
	result(name: string): unknown;
}

type Computed<T> = T | ((context: MockContext) => T);

export interface MockFault {
	kind: ProviderErrorKind;
	retryAfterMs?: number;
}

/** One call's answer. */
export interface MockStep {
	text?: Computed<string>;
	tools?: readonly { name: string; input: Computed<Record<string, unknown>> }[];
	/** A structured output: sent as the text, serialised. */
	json?: Computed<unknown>;
	/** By default refusal with `refusal`, tool_use with tools, end_turn otherwise. */
	stop?: MockStopReason;
	refusal?: { category?: RefusalCategory; explanation?: string };
	/** The coach's model declined (after `partial`, if given) and a fallback model answered. */
	fallback?: { model?: string; category?: RefusalCategory; partial?: string };
	/** An empty progress thinking block first: by default only before tool calls. */
	thinking?: boolean;
	/** The call fails: before any event, or after the step's content when it has some. */
	fault?: MockFault;
	chunkChars?: number;
	/** A wait before every delta. */
	delayMs?: number;
}

export interface MockScript {
	name: string;
	matches?: (ownerText: string) => boolean;
	steps: readonly MockStep[];
}

export interface MockProviderOptions {
	/** By default the overrides the test route set (faults.ts). */
	overrides?: () => MockOverrides;
}

type Event = BetaRawMessageStreamEvent;

export class MockProvider implements LlmProvider {
	readonly name = 'mock' as const;
	readonly model = COACH_MODEL;
	readonly #scripts: readonly MockScript[];
	readonly #overrides: () => MockOverrides;
	/** The digests of the prefixes earlier requests wrote to the cache. */
	readonly #cache = new Set<string>();

	constructor(scripts: readonly MockScript[], options: MockProviderOptions = {}) {
		if (new Set(scripts.map((script) => script.name)).size !== scripts.length)
			throw new Error('Mock script names must be unique');
		this.#scripts = scripts;
		this.#overrides = options.overrides ?? (() => mockOverrides());
	}

	stream(request: ModelRequest, signal: AbortSignal): ModelStream {
		return readOnce(() => this.#answer(request, signal));
	}

	async structured<S extends z.ZodMiniType>(
		request: Omit<ModelRequest, 'tools'>,
		schema: S,
		signal: AbortSignal
	): Promise<StructuredResult<z.output<S>>> {
		const result = await this.stream(request, signal).final();
		if (result.message.stop_reason !== 'end_turn') return { ...result, value: null };
		const text = result.message.content.map((block) => (block.type === 'text' ? block.text : ''));
		let json: unknown;
		try {
			json = JSON.parse(text.join(''));
		} catch (cause) {
			throw new CoachProviderError('invalid_output', 'The structured output is not JSON', {
				cause
			});
		}
		const parsed = z.safeParse(schema, json);
		if (!parsed.success)
			throw new CoachProviderError('invalid_output', 'The structured output fails its schema', {
				cause: parsed.error
			});
		return { ...result, value: parsed.data };
	}

	async countTokens(request: ModelRequest, signal?: AbortSignal): Promise<number> {
		this.#admit(request, signal);
		return render(request).at(-1)?.tokens ?? 0;
	}

	/** What every call checks first: the signal, the API's rules, then an injected fault. */
	#admit(request: ModelRequest, signal: AbortSignal | undefined): MockOverrides {
		if (signal?.aborted) throw aborted();
		const issues = validateRequest(request);
		if (issues.length > 0)
			throw new CoachProviderError(
				'bad_request',
				issues.map((issue) => `${issue.rule} at ${issue.at}`).join('; ')
			);
		const overrides = this.#overrides();
		if (overrides.fault) throw failure(overrides.fault);
		return overrides;
	}

	async *#answer(request: ModelRequest, signal: AbortSignal): AsyncGenerator<Event, ModelResult> {
		const overrides = this.#admit(request, signal);
		const turn = readTurn(request.messages);
		const script = this.#script(overrides.script, turn.ownerText);
		const step = script.steps[turn.step];
		if (!step) throw new Error(`Mock script '${script.name}' has no step ${turn.step + 1}`);
		const seed = createHash('sha256').update(JSON.stringify(request)).digest('hex');
		const content = contentOf(step, turn, seed);
		if (step.fault && content.length === 0) throw failure(step.fault);

		const usage = this.#usage(request, step, content);
		const message = messageOf(`msg_mock_${seed.slice(0, 24)}`, step, content, usage);
		const delayMs = overrides.chunkDelayMs ?? step.delayMs ?? 0;
		const wait = async () => {
			if (delayMs > 0) await sleep(delayMs, signal);
			if (signal.aborted) throw aborted();
		};
		yield* events(message, step.chunkChars ?? CHUNK_CHARS, wait);
		if (step.fault) throw failure(step.fault);
		yield* closing(message, usage);
		return { message, requestId: `req_mock_${seed.slice(0, 24)}` };
	}

	#script(forced: string | undefined, ownerText: string): MockScript {
		const script =
			forced === undefined
				? this.#scripts.find((each) => each.matches?.(ownerText) ?? false)
				: this.#scripts.find((each) => each.name === forced);
		if (!script) throw new Error(forced ? `No mock script '${forced}'` : 'No mock script answers');
		return script;
	}

	/**
	 * Input tokens split as the API splits them: read from the longest cached prefix a breakpoint
	 * finds, written up to the last breakpoint, and the rest uncached. A fallback attempt runs on
	 * another model, whose cache is empty.
	 */
	#usage(request: ModelRequest, step: MockStep, content: BetaContentBlock[]): Usage {
		const positions = render(request);
		const total = positions.at(-1)?.tokens ?? 0;
		const marks = positions.flatMap((position, index) =>
			position.marked && position.tokens >= MIN_CACHEABLE_TOKENS ? [index] : []
		);
		let read = 0;
		for (const mark of marks)
			for (let index = mark; index > mark - CACHE_LOOKBACK && index >= 0; index -= 1)
				if (this.#cache.has(positions[index]!.digest))
					read = Math.max(read, positions[index]!.tokens);
		const written = Math.max(0, (positions[marks.at(-1) ?? -1]?.tokens ?? 0) - read);
		for (const mark of marks) this.#cache.add(positions[mark]!.digest);

		const output = tokens(JSON.stringify(content));
		const attempt = {
			input_tokens: total - read - written,
			cache_read_input_tokens: read,
			cache_creation_input_tokens: written,
			output_tokens: output
		};
		if (!step.fallback) return { ...attempt, iterations: null };
		const partial = tokens(step.fallback.partial ?? '');
		const served = { input_tokens: total, cache_read_input_tokens: 0 };
		const fallback = { ...served, cache_creation_input_tokens: 0, output_tokens: output - partial };
		const iterations: BetaIterationsUsage = [
			{
				...attempt,
				output_tokens: partial,
				type: 'message',
				model: COACH_MODEL,
				cache_creation: null
			},
			{ ...fallback, type: 'fallback_message', model: fallbackModel(step), cache_creation: null }
		];
		return { ...fallback, iterations };
	}
}

const tokens = (text: string) => Math.ceil(Buffer.byteLength(text) / MOCK_BYTES_PER_TOKEN);
const failure = (fault: MockFault) =>
	new CoachProviderError(fault.kind, `Mock fault: ${fault.kind}`, {
		retryAfterMs: fault.retryAfterMs
	});
const aborted = () => new CoachProviderError('aborted', 'The call was aborted');
const fallbackModel = (step: MockStep) => step.fallback?.model ?? FALLBACK_MODEL;

/**
 * The prompt in render order (tools, system, then each message's blocks), as a running digest and
 * token count at every block, and whether a breakpoint sits there. cache_control itself is not
 * rendered, so moving a breakpoint never changes the prefix.
 */
function render(request: ModelRequest) {
	const parts: { text: string; marked: boolean }[] = [];
	const add = (prefix: string, part: unknown) => {
		const { cache_control, ...rest } = part as { cache_control?: unknown };
		parts.push({ text: prefix + JSON.stringify(rest), marked: Boolean(cache_control) });
	};
	for (const tool of request.tools ?? []) add('tool:', tool);
	const system = request.system ?? [];
	for (const block of typeof system === 'string' ? [{ text: system }] : system)
		add('system:', block);
	for (const message of request.messages) {
		const blocks =
			typeof message.content === 'string' ? [{ text: message.content }] : message.content;
		for (const block of blocks ?? []) add(`${message.role}:`, block);
	}
	if (request.cache_control && parts.length > 0) parts.at(-1)!.marked = true;

	const hash = createHash('sha256');
	let bytes = 0;
	return parts.map((part) => {
		hash.update(part.text);
		bytes += Buffer.byteLength(part.text);
		const tokens = Math.ceil(bytes / MOCK_BYTES_PER_TOKEN);
		return { digest: hash.copy().digest('hex'), tokens, marked: part.marked };
	});
}

const blocksOf = (message: BetaMessageParam) =>
	typeof message.content === 'string' ? [] : (message.content ?? []);

/** The turn a request belongs to: the owner's last message, the step reached and the results. */
function readTurn(messages: readonly BetaMessageParam[]) {
	const owner = messages.findLastIndex(
		(message) =>
			message.role === 'user' && !blocksOf(message).some((block) => block.type === 'tool_result')
	);
	const names = new Map<string, string>();
	const results: MockToolResult[] = [];
	let step = 0;
	for (const message of messages.slice(owner + 1)) {
		if (message.role === 'assistant') step += 1;
		for (const block of blocksOf(message)) {
			if (block.type === 'tool_use') names.set(block.id, block.name);
			if (block.type === 'tool_result')
				results.push({
					name: names.get(block.tool_use_id) ?? '',
					isError: block.is_error === true,
					content: parsed(textOf(block.content))
				});
		}
	}
	const context: MockContext = {
		ownerText: owner < 0 ? '' : textOf(messages[owner]!.content),
		results,
		result(name) {
			const found = results.findLast((each) => each.name === name);
			if (!found) throw new Error(`The mock script needs a ${name} result first`);
			return found.content;
		}
	};
	return Object.assign(context, { step });
}

function textOf(content: string | readonly { type: string; text?: string }[] = []): string {
	if (typeof content === 'string') return content;
	return content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

function parsed(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

const computed = <T>(value: Computed<T>, context: MockContext): T =>
	typeof value === 'function' ? (value as (context: MockContext) => T)(context) : value;

function contentOf(step: MockStep, context: MockContext, seed: string): BetaContentBlock[] {
	const content: BetaContentBlock[] = [];
	const text = (words: string): BetaContentBlock => ({
		type: 'text',
		text: words,
		citations: null
	});
	if (step.fallback) {
		if (step.fallback.partial) content.push(text(step.fallback.partial));
		content.push({
			type: 'fallback',
			from: { model: COACH_MODEL },
			to: { model: fallbackModel(step) },
			trigger: { type: 'refusal', category: step.fallback.category ?? null }
		});
	}
	if (step.thinking ?? Boolean(step.tools?.length))
		content.push({
			type: 'thinking',
			thinking: '',
			signature: `mock-signature-${seed.slice(0, 32)}`
		});
	if (step.json !== undefined) content.push(text(JSON.stringify(computed(step.json, context))));
	else if (step.text !== undefined) content.push(text(computed(step.text, context)));
	step.tools?.forEach((call, index) =>
		content.push({
			type: 'tool_use',
			id: `toolu_mock_${seed.slice(0, 20)}_${index}`,
			name: call.name,
			input: computed(call.input, context)
		})
	);
	return content;
}

interface Usage {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
	iterations: BetaIterationsUsage | null;
}

function messageOf(id: string, step: MockStep, content: BetaContentBlock[], usage: Usage) {
	const stop =
		step.stop ?? (step.refusal ? 'refusal' : step.tools?.length ? 'tool_use' : 'end_turn');
	const message: BetaMessage = {
		id,
		type: 'message',
		role: 'assistant',
		model: step.fallback ? fallbackModel(step) : COACH_MODEL,
		content,
		stop_reason: stop,
		stop_sequence: null,
		stop_details:
			stop === 'refusal'
				? {
						type: 'refusal',
						category: step.refusal?.category ?? null,
						explanation: step.refusal?.explanation ?? null,
						fallback_credit_token: null,
						fallback_has_prefill_claim: null,
						recommended_model: null
					}
				: null,
		container: null,
		context_management: null,
		diagnostics: null,
		usage: {
			...usage,
			cache_creation: null,
			fallback_credit: null,
			inference_geo: null,
			output_tokens_details: null,
			server_tool_use: null,
			service_tier: 'standard',
			speed: null
		}
	};
	return message;
}

function chunks(text: string, size: number): string[] {
	const chars = Array.from(text);
	const out: string[] = [];
	for (let start = 0; start < chars.length; start += size)
		out.push(chars.slice(start, start + size).join(''));
	return out;
}

/** A block as content_block_start opens it, and the deltas that complete it. */
function streamed(block: BetaContentBlock, size: number) {
	let start: BetaRawContentBlockStartEvent['content_block'] = block;
	let deltas: BetaRawContentBlockDelta[] = [];
	if (block.type === 'text') {
		start = { ...block, text: '' };
		deltas = chunks(block.text, size).map((text) => ({ type: 'text_delta', text }));
	} else if (block.type === 'thinking') {
		// The mock's thinking is always empty (display omitted): only its signature streams.
		start = { ...block, signature: '' };
		deltas = [{ type: 'signature_delta', signature: block.signature }];
	} else if (block.type === 'tool_use') {
		start = { ...block, input: {} };
		deltas = chunks(JSON.stringify(block.input), size).map((partial_json) => ({
			type: 'input_json_delta',
			partial_json
		}));
	}
	return { start, deltas };
}

/** message_start and every block, each delta after a wait. */
async function* events(message: BetaMessage, size: number, wait: () => Promise<void>) {
	const opening = { ...message, content: [], stop_reason: null, stop_details: null };
	yield {
		type: 'message_start',
		message: { ...opening, usage: { ...message.usage, output_tokens: 0 } }
	} as Event;
	for (const [index, block] of message.content.entries()) {
		const { start, deltas } = streamed(block, size);
		yield { type: 'content_block_start', index, content_block: start } as Event;
		for (const delta of deltas) {
			await wait();
			yield { type: 'content_block_delta', index, delta } as Event;
		}
		yield { type: 'content_block_stop', index } as Event;
	}
}

function* closing({ stop_reason, stop_details }: BetaMessage, usage: Usage): Generator<Event> {
	yield {
		type: 'message_delta',
		delta: { stop_reason, stop_details, stop_sequence: null, container: null },
		usage: { ...usage, fallback_credit: null, output_tokens_details: null, server_tool_use: null },
		context_management: null
	};
	yield { type: 'message_stop' };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', done);
			if (signal.aborted) reject(aborted());
			else resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener('abort', done, { once: true });
	});
}

/**
 * A stream that can be read once, by iterating it or by final(), as the SDK's MessageStream is.
 * Leaving the iteration early settles final() as aborted.
 */
function readOnce(source: () => AsyncGenerator<Event, ModelResult>): ModelStream {
	let started = false;
	const result = Promise.withResolvers<ModelResult>();
	result.promise.catch(() => {}); // the iteration reports the error to a caller that never calls final()

	async function* read(): AsyncGenerator<Event, void> {
		if (started) throw new Error('A model stream can be read once');
		started = true;
		try {
			const events = source();
			let next;
			while (!(next = await events.next()).done) yield next.value;
			result.resolve(next.value);
		} catch (error) {
			result.reject(error);
			throw error;
		} finally {
			// A no-op once settled; otherwise the caller left the iteration early.
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
