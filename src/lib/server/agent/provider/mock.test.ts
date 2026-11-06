import type {
	BetaContentBlock,
	BetaContentBlockParam,
	BetaMessageIterationUsage,
	BetaMessageParam,
	BetaRawMessageStreamEvent,
	BetaTool
} from '@anthropic-ai/sdk/resources/beta/messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/mini';
import { capCostMicros, costMicros } from '../../../domain/coach/pricing.ts';
import { clearMockOverrides, mockOverrides, setMockOverrides } from './faults.ts';
import { MOCK_SCRIPTS } from './mock-scripts/index.ts';
import {
	MIN_CACHEABLE_TOKENS,
	MOCK_BYTES_PER_TOKEN,
	MockProvider,
	type MockScript,
	type MockStep
} from './mock.ts';
import { CoachProviderError, PROVIDER_ERROR_KINDS, type ModelRequest } from './types.ts';
import { validateRequest } from './validate.ts';

/** Long enough that tools plus system pass Opus 5.5's 512-token cache minimum. */
const SYSTEM = 'You are the owner’s performance coach. Answer from tool results only. '.repeat(40);

const tool = (name: string): BetaTool => ({
	name,
	description: `The ${name} tool.`,
	input_schema: {
		type: 'object',
		properties: { exercise: { type: 'string' } },
		required: ['exercise'],
		additionalProperties: false
	},
	strict: true,
	eager_input_streaming: true
});

function request(messages: BetaMessageParam[], system = SYSTEM): ModelRequest {
	return {
		max_tokens: 16_000,
		system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
		tools: [tool('get_exercise_history'), tool('get_personal_records')],
		output_config: { effort: 'medium' },
		cache_control: { type: 'ephemeral' },
		messages
	};
}
const ask = (text: string): BetaMessageParam => ({ role: 'user', content: text });
const answer = (content: BetaContentBlock[]): BetaMessageParam => ({
	role: 'assistant',
	content: content as BetaContentBlockParam[]
});
const open = () => new AbortController().signal;
const mock = (scripts: readonly MockScript[], overrides = () => ({})) =>
	new MockProvider(scripts, { overrides });
const playing = (...steps: MockStep[]) => mock([{ name: 'any', matches: () => true, steps }]);

async function collect(stream: AsyncIterable<BetaRawMessageStreamEvent>) {
	const events: BetaRawMessageStreamEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

/** The content the events describe, put together the way the SDK assembles a stream. */
function assemble(events: BetaRawMessageStreamEvent[]): BetaContentBlock[] {
	const content: Record<string, unknown>[] = [];
	const json: string[] = [];
	for (const event of events) {
		if (event.type === 'content_block_start') {
			content[event.index] = structuredClone(event.content_block) as unknown as Record<
				string,
				unknown
			>;
			json[event.index] = '';
		} else if (event.type === 'content_block_delta') {
			const block = content[event.index]!;
			const delta = event.delta;
			if (delta.type === 'text_delta') block.text += delta.text;
			if (delta.type === 'thinking_delta') block.thinking += delta.thinking;
			if (delta.type === 'signature_delta') block.signature = delta.signature;
			if (delta.type === 'input_json_delta') json[event.index] += delta.partial_json;
		} else if (event.type === 'content_block_stop' && content[event.index]!.type === 'tool_use') {
			content[event.index]!.input = JSON.parse(json[event.index]!);
		}
	}
	return content as unknown as BetaContentBlock[];
}

/** Results by tool name, sent back in one user message as the loop sends them. */
function resultsFor(content: BetaContentBlock[], outputs: Record<string, unknown>) {
	const results: BetaContentBlockParam[] = content.flatMap((block) =>
		block.type === 'tool_use'
			? [
					{
						type: 'tool_result' as const,
						tool_use_id: block.id,
						content: JSON.stringify(outputs[block.name])
					}
				]
			: []
	);
	return { role: 'user', content: results } satisfies BetaMessageParam;
}

/** Runs a turn to its end the way the agent loop will, and returns every call's result. */
async function play(provider: MockProvider, messages: BetaMessageParam[], outputs = {}) {
	const results = [];
	for (;;) {
		const result = await provider.stream(request(messages), open()).final();
		results.push(result);
		messages.push(answer(result.message.content));
		if (result.message.stop_reason !== 'tool_use') return results;
		messages.push(resultsFor(result.message.content, outputs));
	}
}

const types = (content: BetaContentBlock[]) => content.map((block) => block.type);
const textOf = (content: BetaContentBlock[]) =>
	content.map((block) => (block.type === 'text' ? block.text : '')).join('');

/** A history question answered in three steps, each computed from what the tools returned. */
const bench: MockScript = {
	name: 'bench',
	matches: (text) => /bench/i.test(text),
	steps: [
		{ tools: [{ name: 'get_exercise_history', input: { exercise: 'Bench press' } }] },
		{
			tools: [
				{
					name: 'get_personal_records',
					input: (turn) => ({
						exercise: (turn.result('get_exercise_history') as { id: string }).id
					})
				}
			]
		},
		{
			text: (turn) => {
				const history = turn.result('get_exercise_history') as { sessions: number };
				const best = turn.result('get_personal_records') as { kg: number };
				return `[fact] Your best bench is ${best.kg} kg, from ${history.sessions} sessions.`;
			}
		}
	]
};
const BENCH_OUTPUTS = {
	get_exercise_history: { id: 'ex_bench', sessions: 9 },
	get_personal_records: { kg: 102.5 }
};

afterEach(() => {
	clearMockOverrides();
	vi.useRealTimers();
});

describe('MockProvider', () => {
	it('gives identical bytes and usage for the same script and conversation', async () => {
		const run = async () => {
			const stream = mock([bench]).stream(request([ask('How is my bench?')]), open());
			const events = await collect(stream);
			return { events, result: await stream.final() };
		};
		const [first, second] = [await run(), await run()];
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
		expect(first.events[0]!.type).toBe('message_start');
		expect(first.events.at(-1)!.type).toBe('message_stop');
		expect(assemble(first.events)).toEqual(first.result.message.content);
		expect(first.result.message.usage.output_tokens).toBe(
			Math.ceil(JSON.stringify(first.result.message.content).length / MOCK_BYTES_PER_TOKEN)
		);
		expect(first.result.requestId).toMatch(/^req_mock_[0-9a-f]{24}$/);
	});

	it('computes tool inputs and answers from the turn’s earlier results', async () => {
		const results = await play(mock([bench]), [ask('How has my bench progressed?')], BENCH_OUTPUTS);
		expect(results.map((result) => result.message.stop_reason)).toEqual([
			'tool_use',
			'tool_use',
			'end_turn'
		]);
		const second = results[1]!.message.content.find((block) => block.type === 'tool_use');
		expect(second).toMatchObject({ name: 'get_personal_records', input: { exercise: 'ex_bench' } });
		expect(textOf(results[2]!.message.content)).toBe(
			'[fact] Your best bench is 102.5 kg, from 9 sessions.'
		);
	});

	it('starts each owner message at the script’s first step', async () => {
		const messages = [ask('How is my bench?')];
		await play(mock([bench]), messages, BENCH_OUTPUTS);
		messages.push(ask('And my bench last year?'));
		const result = await mock([bench]).stream(request(messages), open()).final();
		expect(types(result.message.content)).toEqual(['thinking', 'tool_use']);
	});

	it('sends a tool step as [empty thinking, tool_use…] whose replay passes validateRequest', async () => {
		const parallel = playing({
			tools: [
				{ name: 'get_exercise_history', input: { exercise: 'Squat' } },
				{ name: 'get_personal_records', input: { exercise: 'Squat' } }
			]
		});
		const messages = [ask('How is my squat?')];
		const { message } = await parallel.stream(request(messages), open()).final();
		expect(types(message.content)).toEqual(['thinking', 'tool_use', 'tool_use']);
		expect(message.content[0]).toMatchObject({ thinking: '', signature: /^mock-signature-/ });
		const replay = request([...messages, answer(message.content), resultsFor(message.content, {})]);
		expect(validateRequest(replay)).toEqual([]);

		const ids = message.content.flatMap((block) => (block.type === 'tool_use' ? [block.id] : []));
		expect(new Set(ids).size).toBe(2);
	});

	it('shows text with a tool call, or thinking before text, only when the script asks', async () => {
		const withText = playing({
			text: 'Let me check your log.',
			tools: [{ name: 'get_exercise_history', input: { exercise: 'Row' } }]
		});
		const first = await withText.stream(request([ask('Rows?')]), open()).final();
		expect(types(first.message.content)).toEqual(['thinking', 'text', 'tool_use']);
		const plain = await playing({ text: 'Hi' })
			.stream(request([ask('Hi')]), open())
			.final();
		expect(types(plain.message.content)).toEqual(['text']);
		const thought = playing({ text: 'Hi', thinking: true });
		const second = await thought.stream(request([ask('Hi')]), open()).final();
		expect(types(second.message.content)).toEqual(['thinking', 'text']);
	});

	it.each([
		[{ text: 'Done.' }, 'end_turn'],
		[{ tools: [{ name: 'get_exercise_history', input: { exercise: 'Row' } }] }, 'tool_use'],
		[{ text: 'A long answer that was cut', stop: 'max_tokens' }, 'max_tokens'],
		[{ stop: 'pause_turn' }, 'pause_turn'],
		[{ refusal: { category: 'bio', explanation: 'Declined' } }, 'refusal']
	] as [MockStep, string][])('ends a step with %o as %s', async (step, stop) => {
		const stream = playing(step).stream(request([ask('Go')]), open());
		const events = await collect(stream);
		const { message } = await stream.final();
		expect(message.stop_reason).toBe(stop);
		const delta = events.find((event) => event.type === 'message_delta');
		expect(delta).toMatchObject({ delta: { stop_reason: stop } });
		if (stop === 'refusal')
			expect(message.stop_details).toEqual({
				type: 'refusal',
				category: 'bio',
				explanation: 'Declined',
				fallback_credit_token: null,
				fallback_has_prefill_claim: null,
				recommended_model: null
			});
		else expect(message.stop_details).toBeNull();
	});

	it('serves a fallback with its block, the served model and both attempts in usage', async () => {
		const provider = playing({ fallback: { category: 'cyber' }, text: 'Here is the plan.' });
		const { message } = await provider.stream(request([ask('Plan?')]), open()).final();
		expect(message.content[0]).toEqual({
			type: 'fallback',
			from: { model: 'claude-opus-5-5' },
			to: { model: 'claude-opus-5' },
			trigger: { type: 'refusal', category: 'cyber' }
		});
		expect(textOf(message.content)).toBe('Here is the plan.');
		expect(message.model).toBe('claude-opus-5');
		const [declined, served] = message.usage.iterations!;
		expect(declined).toMatchObject({ type: 'message', model: 'claude-opus-5-5', output_tokens: 0 });
		expect(served).toMatchObject({ type: 'fallback_message', model: 'claude-opus-5' });
		expect(message.usage.input_tokens).toBe(served!.input_tokens);
		expect(message.usage.output_tokens).toBe(served!.output_tokens);

		const partial = playing({
			fallback: { partial: 'Sure, here', model: 'claude-opus-4-8' },
			text: 'x'
		});
		const mid = await partial.stream(request([ask('Plan?')]), open()).final();
		expect(types(mid.message.content)).toEqual(['text', 'fallback', 'text']);
		expect(mid.message.usage.iterations![0]!.output_tokens).toBeGreaterThan(0);
		// The domain's pricing reads the attempts as the agent will map them.
		const iterations = (mid.message.usage.iterations as BetaMessageIterationUsage[]).map(
			(attempt) => ({
				inputTokens: attempt.input_tokens,
				outputTokens: attempt.output_tokens,
				cacheReadTokens: attempt.cache_read_input_tokens,
				cacheWriteTokens: attempt.cache_creation_input_tokens,
				kind: attempt.type,
				model: attempt.model!
			})
		);
		const priced = { ...iterations[1]!, iterations };
		expect(costMicros(priced, mid.message.model)).toBeGreaterThan(0);
		expect(capCostMicros(priced, mid.message.model)).toBeGreaterThan(0);
	});

	it.each(PROVIDER_ERROR_KINDS)('fails with a typed %s fault before any event', async (kind) => {
		const stream = playing({ fault: { kind, retryAfterMs: 2_000 } }).stream(
			request([ask('Go')]),
			open()
		);
		const events: BetaRawMessageStreamEvent[] = [];
		const failed = (async () => {
			for await (const event of stream) events.push(event);
		})();
		await expect(failed).rejects.toMatchObject({ name: 'CoachProviderError', kind });
		await expect(stream.final()).rejects.toBeInstanceOf(CoachProviderError);
		expect(events).toEqual([]);
		await expect(
			playing({ fault: { kind: 'rate_limited', retryAfterMs: 2_000 } })
				.stream(request([ask('Go')]), open())
				.final()
		).rejects.toMatchObject({ retryAfterMs: 2_000 });
	});

	it('fails mid-stream after the content a faulty step already sent', async () => {
		const stream = playing({ text: 'Your squat went', fault: { kind: 'connection' } }).stream(
			request([ask('Squat?')]),
			open()
		);
		const events: BetaRawMessageStreamEvent[] = [];
		await expect(
			(async () => {
				for await (const event of stream) events.push(event);
			})()
		).rejects.toMatchObject({ kind: 'connection' });
		expect(textOf(assemble(events))).toBe('Your squat went');
		expect(events.some((event) => event.type === 'message_delta')).toBe(false);
	});

	it('reads the cache on a repeated prefix, and not after a one-byte change', async () => {
		const provider = mock(MOCK_SCRIPTS);
		const turn1 = await provider.stream(request([ask('How is my squat?')]), open()).final();
		const first = turn1.message.usage;
		const total = first.input_tokens + first.cache_creation_input_tokens!;
		expect(first.cache_read_input_tokens).toBe(0);
		expect(first.cache_creation_input_tokens).toBeGreaterThan(MIN_CACHEABLE_TOKENS);
		expect(await provider.countTokens(request([ask('How is my squat?')]))).toBe(total);

		const thread = [ask('How is my squat?'), answer(turn1.message.content), ask('And bench?')];
		const turn2 = await provider.stream(request(thread), open()).final();
		expect(turn2.message.usage.cache_read_input_tokens).toBe(total);

		const fresh = await provider.stream(request([ask('Something else')]), open()).final();
		const prefix = fresh.message.usage.cache_read_input_tokens!;
		expect(prefix).toBeGreaterThan(MIN_CACHEABLE_TOKENS);
		expect(prefix).toBeLessThan(total);

		const edited = SYSTEM.slice(0, -1) + '!';
		const changed = await provider.stream(request(thread, edited), open()).final();
		expect(changed.message.usage.cache_read_input_tokens).toBe(0);
		expect(changed.message.usage.cache_creation_input_tokens).toBeGreaterThan(0);
	});

	it('never caches a prefix shorter than the minimum', async () => {
		const provider = mock(MOCK_SCRIPTS);
		const short = { ...request([ask('Hi')], 'Coach.'), tools: [] };
		for (const _call of [1, 2]) {
			const { message } = await provider.stream(short, open()).final();
			expect(message.usage.cache_read_input_tokens).toBe(0);
			expect(message.usage.cache_creation_input_tokens).toBe(0);
		}
	});

	it('refuses a request the API would refuse, in a stream and in a count', async () => {
		const provider = mock(MOCK_SCRIPTS);
		const prefill = request([ask('Hi'), { role: 'assistant', content: 'Sure' }]);
		const failure = { name: 'CoachProviderError', kind: 'bad_request', message: /prefill/ };
		await expect(provider.stream(prefill, open()).final()).rejects.toMatchObject(failure);
		await expect(provider.countTokens(prefill)).rejects.toMatchObject(failure);
		const sampled = { ...request([ask('Hi')]), temperature: 0.2 } as ModelRequest;
		await expect(provider.stream(sampled, open()).final()).rejects.toMatchObject({
			kind: 'bad_request',
			message: /sampling at temperature/
		});
	});

	it('answers with the general scripts: a greeting, and no data for anything else', async () => {
		const provider = mock(MOCK_SCRIPTS);
		const hello = await provider.stream(request([ask('Hello coach')]), open()).final();
		expect(textOf(hello.message.content)).toMatch(/^Hi, I’m your coach\./);
		const other = await provider.stream(request([ask('What is my VO2max?')]), open()).final();
		expect(textOf(other.message.content)).toMatch(/^\[note\] I don’t have data for that yet\./);
		expect(types(other.message.content)).toEqual(['text']);
	});

	it('refuses duplicate script names, and a turn longer than its script', async () => {
		expect(() => mock([bench, bench])).toThrow(/unique/);
		const one = playing({ tools: [{ name: 'get_exercise_history', input: { exercise: 'Row' } }] });
		const messages = [ask('Rows?')];
		const { message } = await one.stream(request(messages), open()).final();
		messages.push(answer(message.content), resultsFor(message.content, {}));
		await expect(one.stream(request(messages), open()).final()).rejects.toThrow(/has no step 2/);
	});

	it('waits before each chunk, and stops when the signal aborts', async () => {
		vi.useFakeTimers();
		const slow = playing({ text: 'x'.repeat(48), chunkChars: 16, delayMs: 1_000 });
		let settled = false;
		const done = slow
			.stream(request([ask('Go')]), open())
			.final()
			.then((result) => ((settled = true), result));
		await vi.advanceTimersByTimeAsync(2_999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(textOf((await done).message.content)).toBe('x'.repeat(48));

		const controller = new AbortController();
		const stopped = slow.stream(request([ask('Go')]), controller.signal);
		const ending = expect(stopped.final()).rejects.toMatchObject({ kind: 'aborted' });
		await vi.advanceTimersByTimeAsync(1_500);
		controller.abort();
		await ending;
	});

	it('can be read once, and settles final() as aborted when left early', async () => {
		const stream = playing({ text: 'x'.repeat(64) }).stream(request([ask('Go')]), open());
		for await (const event of stream) if (event.type === 'content_block_start') break;
		await expect(stream.final()).rejects.toMatchObject({ kind: 'aborted' });
		await expect(collect(stream)).rejects.toThrow(/read once/);
	});

	it('returns schema-checked structured output, and null when the call stops early', async () => {
		const schema = z.object({ title: z.string(), weeks: z.number() });
		const draft = { ...request([ask('Draft a deload')]), tools: undefined };
		const good = playing({ json: { title: 'Deload', weeks: 1 } });
		expect((await good.structured(draft, schema, open())).value).toEqual({
			title: 'Deload',
			weeks: 1
		});
		const bad = playing({ json: { title: 'Deload', weeks: 'one' } });
		await expect(bad.structured(draft, schema, open())).rejects.toMatchObject({
			kind: 'invalid_output'
		});
		const prose = playing({ text: 'Not JSON' });
		await expect(prose.structured(draft, schema, open())).rejects.toMatchObject({
			kind: 'invalid_output'
		});
		const refused = playing({ refusal: { category: null } });
		const result = await refused.structured(draft, schema, open());
		expect(result.value).toBeNull();
		expect(result.message.stop_reason).toBe('refusal');
	});
});

describe('mock overrides', () => {
	it('are set only where test routes are enabled, and read only there', () => {
		expect(() => setMockOverrides({ script: 'bench' }, false)).toThrow(/test route/);
		expect(mockOverrides(() => true)).toEqual({});
		setMockOverrides({ script: 'bench', chunkDelayMs: 5 }, true);
		expect(mockOverrides(() => true)).toEqual({ script: 'bench', chunkDelayMs: 5 });
		expect(mockOverrides(() => false)).toEqual({});
		clearMockOverrides();
		expect(mockOverrides(() => true)).toEqual({});
	});

	it('force a script, inject a fault on every call, and slow every chunk', async () => {
		vi.useFakeTimers();
		const provider = new MockProvider([bench, ...MOCK_SCRIPTS], {
			overrides: () => mockOverrides(() => true)
		});
		setMockOverrides({ script: 'bench' }, true);
		const forced = await provider.stream(request([ask('Hello')]), open()).final();
		expect(types(forced.message.content)).toEqual(['thinking', 'tool_use']);

		setMockOverrides({ fault: { kind: 'overloaded' } }, true);
		await expect(provider.stream(request([ask('Hello')]), open()).final()).rejects.toMatchObject({
			kind: 'overloaded'
		});
		await expect(provider.countTokens(request([ask('Hello')]))).rejects.toMatchObject({
			kind: 'overloaded'
		});

		setMockOverrides({ chunkDelayMs: 500 }, true);
		let settled = false;
		const slow = provider
			.stream(request([ask('Hello')]), open())
			.final()
			.then(() => (settled = true));
		await vi.advanceTimersByTimeAsync(499);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(60_000);
		await slow;
		expect(settled).toBe(true);
	});
});
