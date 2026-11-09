import type { BetaMessage, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/mini';
import { TURN_LIMITS, turnLimits, type TurnLimits } from '../../domain/coach/budgets.ts';
import { costMicros } from '../../domain/coach/pricing.ts';
import type { ToolName } from '../../domain/coach/tools.ts';
import { logger } from '../observability/logger.ts';
import type { ActivityEvent, LoopStep, ModelCallRecord, ReissueReason } from './hooks.ts';
import { modelUsage, runLoop, type LoopResult } from './orchestrator.ts';
import type { MockOverrides } from './provider/faults.ts';
import { MockProvider, type MockScript, type MockStep } from './provider/mock.ts';
import type { LlmProvider, ModelRequest, ModelStream } from './provider/types.ts';
import { validateRequest } from './provider/validate.ts';
import { toolContext, type ToolContext, type ToolDrafter } from './tools/context.ts';
import { defineTool, type CoachTool } from './tools/define.ts';

const SECOND = 1000;
const OWNER = '00000000-0000-4000-8000-000000000001';
const QUESTION = 'How is my squat going?';

interface Deps {
	db: string;
}

const input = z.object({ exercise: z.optional(z.string().check(z.minLength(1))) });
const output = z.object({ value: z.optional(z.number()) });
type Run = (parsed: z.output<typeof input>, ctx: ToolContext<Deps>) => Promise<unknown>;

const tool = (name: ToolName, run: Run): CoachTool<Deps> =>
	defineTool({ name, description: `The ${name} tool.`, input, output, run: run as never });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A tool that takes `ms` and ignores its signal, as a slow service call would. */
const taking = (name: ToolName, ms: number, log: string[] = []) =>
	tool(name, async () => {
		log.push(`start ${name} ${Date.now() - T0}`);
		await sleep(ms);
		log.push(`end ${name} ${Date.now() - T0}`);
		return { value: ms };
	});

const T0 = Date.parse('2026-11-06T09:00:00Z');

function context(serial = false, drafter: ToolDrafter | null = null): ToolContext<Deps> {
	return toolContext({
		session: { ownerId: OWNER },
		message: { threadId: 'thread-1', runId: 'run-1', text: QUESTION, entry: null },
		day: { today: '2026-11-06', timeZone: 'Europe/London' },
		runtime: { deps: { db: serial ? 'transaction' : 'pool' }, serialTools: serial },
		// The loop replaces both with the turn's own.
		signal: new AbortController().signal,
		deadlineAt: 0,
		matchExercise: () => null,
		drafter
	});
}

/** Long enough to be cached (Opus 5.5 caches a prefix of 512 tokens or more). */
const SYSTEM = `You are a coach.${' Answer from the owner’s own data.'.repeat(80)}`;

function firstRequest(tools: readonly CoachTool<Deps>[]): ModelRequest {
	const definitions = [...tools]
		.sort((a, b) => (a.name < b.name ? -1 : 1))
		.map((each) => ({ ...each.definition }));
	return {
		max_tokens: TURN_LIMITS.maxTokens.chat,
		...(definitions.length > 0 && { tools: definitions }),
		system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
		messages: [
			{ role: 'user', content: QUESTION },
			{ role: 'system', content: 'Turn context: Friday 6 November 2026.' }
		],
		output_config: { effort: 'medium' },
		cache_control: { type: 'ephemeral' }
	};
}

/** A provider that records every request it is sent and every message it returns. */
function recording(inner: LlmProvider) {
	const requests: ModelRequest[] = [];
	const messages: BetaMessage[] = [];
	const provider: LlmProvider = {
		name: inner.name,
		model: inner.model,
		stream(request, signal): ModelStream {
			requests.push(structuredClone(request));
			const stream = inner.stream(request, signal);
			return {
				[Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
				async final() {
					const result = await stream.final();
					messages.push(structuredClone(result.message));
					return result;
				}
			};
		},
		structured: (request, schema, signal) => inner.structured(request, schema, signal),
		countTokens: (request, signal) => inner.countTokens(request, signal)
	};
	return { provider, requests, messages };
}

interface Played {
	result: LoopResult;
	requests: ModelRequest[];
	messages: BetaMessage[];
	text: string;
	log: string[];
	activity: ActivityEvent[];
	calls: ModelCallRecord[];
	reissues: ReissueReason[];
	persisted: LoopStep[];
	fallbacks: number;
	elapsedMs: number;
}

interface PlayOptions {
	scripts?: MockScript[];
	tools?: CoachTool<Deps>[];
	serial?: boolean;
	drafter?: ToolDrafter;
	limits?: TurnLimits;
	overrides?: () => MockOverrides;
	cancelRequested?: () => boolean;
	/** Aborts the caller's signal this long after the turn starts. */
	disconnectAfterMs?: number;
	disconnectGraceMs?: number;
	/** The endpoint's deadline, this long after the loop starts. */
	deadlineInMs?: number;
	/** Wraps the mock, to send what it cannot. */
	wrap?: (inner: LlmProvider) => LlmProvider;
}

const script = (...steps: MockStep[]): MockScript => ({ name: 'turn', matches: () => true, steps });

/** Plays one turn on fake time, advancing it until the loop settles. */
async function play(options: PlayOptions & { steps?: MockStep[] }): Promise<Played> {
	const scripts = options.scripts ?? [script(...(options.steps ?? []))];
	const mock = new MockProvider(scripts, { overrides: options.overrides ?? (() => ({})) });
	const { provider, requests, messages } = recording(options.wrap?.(mock) ?? mock);
	const tools = options.tools ?? [];
	const caller = new AbortController();
	if (options.disconnectAfterMs !== undefined)
		setTimeout(() => caller.abort(), options.disconnectAfterMs);
	const played = {
		text: '',
		log: [] as string[],
		activity: [] as ActivityEvent[],
		calls: [] as ModelCallRecord[],
		reissues: [] as ReissueReason[],
		persisted: [] as LoopStep[],
		fallbacks: 0
	};
	let settled: LoopResult | undefined;
	let failure: unknown;
	const started = Date.now();
	let elapsedMs = 0;
	runLoop({
		provider,
		request: firstRequest(tools),
		context: context(options.serial, options.drafter),
		signal: caller.signal,
		tools,
		limits: options.limits,
		disconnectGraceMs: options.disconnectGraceMs,
		...(options.deadlineInMs !== undefined && { deadlineAt: Date.now() + options.deadlineInMs }),
		hooks: {
			onText: (text) => void (played.text += text),
			onFallback: () => void (played.fallbacks += 1),
			onReissue: (reason) => void played.reissues.push(reason),
			onActivity: (event) => {
				played.activity.push(event);
				played.log.push(`activity ${event.state} ${event.id}`);
			},
			onCall: (call) => void played.calls.push(call),
			persistStep: async (step) => {
				played.log.push(`persist ${step.index}`);
				played.persisted.push(structuredClone(step));
			},
			cancelRequested: options.cancelRequested
		}
	}).then(
		(result) => {
			settled = result;
			elapsedMs = Date.now() - started;
		},
		(error: unknown) => (failure = error)
	);
	for (let i = 0; i < 5_000 && !settled && failure === undefined; i++)
		await vi.advanceTimersByTimeAsync(250);
	if (failure !== undefined) throw failure;
	if (!settled) throw new Error('The loop never settled');
	return { result: settled, requests, messages, elapsedMs, ...played };
}

const toolCall = (name: ToolName, toolInput: Record<string, unknown> = {}) => ({
	name,
	input: toolInput
});
const json = (value: unknown) => JSON.stringify(value);
const resultsOf = (step: LoopStep) =>
	(step.results.content as { content: string; is_error?: boolean }[]).map((each) => ({
		...JSON.parse(each.content),
		is_error: each.is_error ?? false
	}));

/** Each request the API would accept, as the mock already checked; and each grows the last. */
function expectValidRequests(requests: ModelRequest[]) {
	for (const request of requests) expect(validateRequest(request)).toEqual([]);
}

beforeEach(() => {
	vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('runLoop: answers', () => {
	it('streams a text answer and completes in one call', async () => {
		const played = await play({ steps: [{ text: 'Your squat is up 5 kg this block.' }] });
		expect(played.result).toMatchObject({
			outcome: 'completed',
			stopReason: 'end_turn',
			steps: [],
			stopCause: null,
			error: null
		});
		expect(played.text).toBe('Your squat is up 5 kg this block.');
		expect(played.result.answer).toEqual(played.messages[0]);
		expect(played.calls).toHaveLength(1);
		expectValidRequests(played.requests);
	});

	it('runs a tool, stores the step verbatim with its result, then answers', async () => {
		const history = taking('get_exercise_history', 2 * SECOND);
		const played = await play({
			tools: [history],
			steps: [
				{ tools: [toolCall('get_exercise_history', { exercise: 'Back squat' })] },
				{ text: (turn) => `Best ${json(turn.result('get_exercise_history'))}` }
			]
		});
		expect(played.result.outcome).toBe('completed');
		expect(played.text).toBe('Best {"value":2000}');
		expect(played.requests).toHaveLength(2);
		expectValidRequests(played.requests);

		const [step] = played.result.steps;
		// The progress thinking block is kept, signature and all, and never reached onText.
		expect(step!.assistant.content).toEqual(played.messages[0]!.content);
		expect(json(step!.assistant.content)).toBe(json(played.messages[0]!.content));
		expect(played.messages[0]!.content[0]).toMatchObject({ type: 'thinking', thinking: '' });
		expect(played.persisted).toEqual([step]);
		// Request 2 is request 1 plus exactly the stored step, byte for byte.
		const [first, second] = played.requests;
		expect(json(second!.messages)).toBe(json([...first!.messages, step!.assistant, step!.results]));
		expect(resultsOf(step!)).toEqual([{ value: 2000, is_error: false }]);
		const id = step!.outcomes[0]!.toolUseId;
		expect(played.activity).toEqual([
			{
				type: 'activity',
				id,
				tool: 'get_exercise_history',
				state: 'running',
				label: 'Looking at your Back squat history…'
			},
			{
				type: 'activity',
				id,
				tool: 'get_exercise_history',
				state: 'done',
				label: 'Looked at your Back squat history'
			}
		]);
		// The step is stored before any chip says it is done.
		expect(played.log).toEqual([`activity running ${id}`, 'persist 0', `activity done ${id}`]);
	});

	it('passes a fallback on and prices each attempt at its own model', async () => {
		const played = await play({
			steps: [{ fallback: { partial: 'I can help with', category: 'cyber' }, text: 'Here it is.' }]
		});
		expect(played.result.outcome).toBe('completed');
		expect(played.fallbacks).toBe(1);
		const message = played.messages[0]!;
		const usage = modelUsage(message.usage, message.model);
		expect(usage.iterations?.map((each) => [each.kind, each.model])).toEqual([
			['message', 'claude-opus-5-5'],
			['fallback_message', 'claude-opus-5']
		]);
		expect(played.result.usage.costMicros).toBe(costMicros(usage, message.model));
	});
});

describe('runLoop: tools', () => {
	const three = (log: string[]) => [
		taking('get_exercise_history', 3 * SECOND, log),
		taking('get_personal_records', 3 * SECOND, log),
		taking('get_recent_workouts', 3 * SECOND, log)
	];
	const calls = [
		toolCall('get_exercise_history'),
		toolCall('get_personal_records'),
		toolCall('get_recent_workouts')
	];

	it('runs a step’s tools together on the pool', async () => {
		const log: string[] = [];
		const played = await play({ tools: three(log), steps: [{ tools: calls }, { text: 'Done.' }] });
		expect(played.result.outcome).toBe('completed');
		expect(log.filter((line) => line.startsWith('start'))).toEqual([
			'start get_exercise_history 0',
			'start get_personal_records 0',
			'start get_recent_workouts 0'
		]);
		// All three results go back in one user message, in tool_use order.
		expect(played.result.steps[0]!.results.content).toHaveLength(3);
	});

	it('runs them one at a time when the services hold a transaction', async () => {
		const log: string[] = [];
		const played = await play({
			serial: true,
			tools: three(log),
			steps: [{ tools: calls }, { text: 'Done.' }]
		});
		expect(played.result.outcome).toBe('completed');
		expect(log).toEqual([
			'start get_exercise_history 0',
			'end get_exercise_history 3000',
			'start get_personal_records 3000',
			'end get_personal_records 6000',
			'start get_recent_workouts 6000',
			'end get_recent_workouts 9000'
		]);
	});

	it('answers invalid input with an is_error result and never runs the tool', async () => {
		const run = vi.fn(async () => ({ value: 1 }));
		const played = await play({
			tools: [tool('get_exercise_history', run)],
			steps: [
				{ tools: [toolCall('get_exercise_history', { exercise: '', extra: true })] },
				{ text: 'I could not read that.' }
			]
		});
		expect(run).not.toHaveBeenCalled();
		expect(played.result.outcome).toBe('completed');
		expect(resultsOf(played.result.steps[0]!)).toMatchObject([
			{ error: 'INVALID_INPUT', is_error: true }
		]);
		expect(played.activity.at(-1)).toMatchObject({ state: 'failed' });
		expectValidRequests(played.requests);
	});

	it('answers a throwing tool with an is_error result and carries on', async () => {
		vi.spyOn(logger, 'error').mockImplementation(() => {});
		const played = await play({
			tools: [
				tool('get_exercise_history', async () => {
					throw new Error('database down');
				})
			],
			steps: [{ tools: [toolCall('get_exercise_history')] }, { text: 'Without it, then.' }]
		});
		expect(played.result.outcome).toBe('completed');
		expect(resultsOf(played.result.steps[0]!)).toMatchObject([
			{ error: 'INTERNAL', is_error: true }
		]);
		expect(played.text).toBe('Without it, then.');
	});

	it.each([
		[180, 'succeeded', 'timed_out'],
		[60, 'timed_out', 'timed_out']
	] as const)(
		'at %i s, a 40 s drafting tool is %s and a 12 s reading tool is %s',
		async (seconds, drafting, reading) => {
			const played = await play({
				limits: turnLimits(seconds),
				tools: [taking('update_workout', 40 * SECOND), taking('get_exercise_history', 12 * SECOND)],
				steps: [
					{ tools: [toolCall('update_workout'), toolCall('get_exercise_history')] },
					{ text: 'Done.' }
				]
			});
			const outcomes = played.result.steps[0]!.outcomes;
			expect(outcomes.map((each) => each.status)).toEqual([drafting, reading]);
			expect(outcomes[1]!.durationMs).toBe(10 * SECOND);
			if (seconds === 60) expect(outcomes[0]!.durationMs).toBe(25 * SECOND);
			expect(played.result.outcome).toBe('completed');
		}
	);
});

describe('runLoop: stop reasons', () => {
	it('runs no tool on a refusal, even one the message holds', async () => {
		const run = vi.fn(async () => ({ value: 1 }));
		const played = await play({
			tools: [tool('get_exercise_history', run)],
			steps: [
				{
					tools: [toolCall('get_exercise_history')],
					refusal: { category: 'bio', explanation: 'Declined' }
				}
			]
		});
		expect(run).not.toHaveBeenCalled();
		expect(played.result).toMatchObject({ outcome: 'refused', stopReason: 'refusal', steps: [] });
		expect(played.result.answer?.stop_details?.category).toBe('bio');
		expect(played.calls[0]!.refusalCategory).toBe('bio');
	});

	it('never runs a truncated tool_use: it re-issues once with more room, then stops', async () => {
		const run = vi.fn(async () => ({ value: 1 }));
		const played = await play({
			tools: [tool('get_exercise_history', run)],
			steps: [{ tools: [toolCall('get_exercise_history')], stop: 'max_tokens' }]
		});
		expect(run).not.toHaveBeenCalled();
		expect(played.requests.map((each) => each.max_tokens)).toEqual([16_000, 32_000]);
		expect(played.reissues).toEqual(['max_tokens']);
		expect(played.result).toMatchObject({ outcome: 'budget_exhausted', stopReason: 'max_tokens' });
		expect(played.result.steps).toEqual([]);
	});

	it('runs the tool once the re-issued call fits, and goes back to the usual room', async () => {
		let n = 0;
		const played = await play({
			tools: [taking('get_exercise_history', SECOND)],
			scripts: [
				{
					name: 'cut',
					steps: [{ tools: [toolCall('get_exercise_history')], stop: 'max_tokens' }]
				},
				{
					name: 'whole',
					steps: [{ tools: [toolCall('get_exercise_history')] }, { text: 'Done.' }]
				}
			],
			overrides: () => ({ script: n++ === 0 ? 'cut' : 'whole' })
		});
		expect(played.result.outcome).toBe('completed');
		expect(played.result.steps).toHaveLength(1);
		expect(played.requests.map((each) => each.max_tokens)).toEqual([16_000, 32_000, 16_000]);
	});

	it('ends a text answer cut at max_tokens as budget_exhausted, with the partial answer', async () => {
		const played = await play({ steps: [{ text: 'Your squat is', stop: 'max_tokens' }] });
		expect(played.result.outcome).toBe('budget_exhausted');
		expect(played.result.answer).toEqual(played.messages[0]);
		expect(played.requests).toHaveLength(1);
	});

	it('runs no tool when the context window is full, and ends budget_exhausted', async () => {
		const run = vi.fn(async () => ({ value: 1 }));
		const full = (inner: LlmProvider): LlmProvider => ({
			...inner,
			stream(request, signal) {
				const stream = inner.stream(request, signal);
				return {
					[Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
					async final() {
						const result = await stream.final();
						const stop_reason = 'model_context_window_exceeded' as const;
						return { ...result, message: { ...result.message, stop_reason } };
					}
				};
			}
		});
		const played = await play({
			wrap: full,
			tools: [tool('get_exercise_history', run)],
			steps: [{ tools: [toolCall('get_exercise_history')] }, { text: 'never' }]
		});
		expect(played.result.outcome).toBe('budget_exhausted');
		expect(played.result.answer?.stop_reason).toBe('model_context_window_exceeded');
		expect(played.requests).toHaveLength(1);
		expect(run).not.toHaveBeenCalled();
	});

	it('continues a paused turn with the same request', async () => {
		let n = 0;
		const played = await play({
			scripts: [
				{ name: 'paused', steps: [{ stop: 'pause_turn' }] },
				{ name: 'answer', steps: [{ text: 'Done.' }] }
			],
			overrides: () => ({ script: n++ === 0 ? 'paused' : 'answer' })
		});
		expect(played.result.outcome).toBe('completed');
		expect(played.reissues).toEqual(['pause_turn']);
		expect(json(played.requests[1])).toBe(json(played.requests[0]));
	});

	it('re-issues a call whose tool input is not JSON, at most twice', async () => {
		let n = 0;
		const recovered = await play({
			tools: [taking('get_exercise_history', SECOND)],
			steps: [{ tools: [toolCall('get_exercise_history')] }, { text: 'Done.' }],
			overrides: () => (n++ < 2 ? { fault: { kind: 'invalid_tool_json' } } : {})
		});
		expect(recovered.result.outcome).toBe('completed');
		expect(recovered.reissues).toEqual(['invalid_tool_json', 'invalid_tool_json']);
		expect(recovered.calls.map((each) => each.error)).toEqual([
			'invalid_tool_json',
			'invalid_tool_json',
			null,
			null
		]);

		const broken = await play({
			steps: [{ text: 'never' }],
			overrides: () => ({ fault: { kind: 'invalid_tool_json' } })
		});
		expect(broken.result).toMatchObject({
			outcome: 'failed',
			error: { kind: 'invalid_tool_json' }
		});
		expect(broken.calls).toHaveLength(3);
	});

	it('counts the input a call that fails mid-stream was billed for', async () => {
		const played = await play({
			steps: [{ text: 'Your squat', fault: { kind: 'overloaded' } }]
		});
		expect(played.result.outcome).toBe('failed');
		const [call] = played.calls;
		expect(call!.usage.inputTokens + call!.usage.cacheWriteTokens).toBeGreaterThan(0);
		expect(call!.costMicros).toBeGreaterThan(0);
		expect(played.result.usage.capCostMicros).toBe(call!.capCostMicros);
		expect(played.result.usage.budget.inputTokens).toBeGreaterThan(0);
	});

	it('fails the turn on any other provider error, without retrying it', async () => {
		const played = await play({
			steps: [{ text: 'never' }],
			overrides: () => ({ fault: { kind: 'overloaded' } })
		});
		expect(played.result).toMatchObject({ outcome: 'failed', error: { kind: 'overloaded' } });
		expect(played.calls).toHaveLength(1);
	});
});

describe('runLoop: limits', () => {
	const forever = (n: number): MockStep[] =>
		Array.from({ length: n }, () => ({ tools: [toolCall('get_exercise_history')] }));

	it('stops at the chat-call cap without running the last call’s tools', async () => {
		const run = vi.fn(async () => ({ value: 1 }));
		const played = await play({
			tools: [tool('get_exercise_history', run)],
			steps: forever(TURN_LIMITS.chatCalls + 2)
		});
		expect(played.requests).toHaveLength(TURN_LIMITS.chatCalls);
		expect(played.result).toMatchObject({ outcome: 'budget_exhausted', limit: 'chat_calls' });
		expect(played.result.steps).toHaveLength(TURN_LIMITS.chatCalls - 1);
		expect(run).toHaveBeenCalledTimes(TURN_LIMITS.chatCalls - 1);
		expectValidRequests(played.requests);
	});

	it('checks the token budget after every call', async () => {
		const run = vi.fn(async () => ({ value: 1 }));
		const measured = await play({
			tools: [tool('get_exercise_history', run)],
			steps: [...forever(1), { text: 'Done.' }]
		});
		const firstCall = measured.calls[0]!.usage;
		const firstInput =
			firstCall.inputTokens + firstCall.cacheReadTokens + firstCall.cacheWriteTokens;
		run.mockClear();

		// Room for the first call's input, not for the second's.
		const played = await play({
			limits: { ...TURN_LIMITS, inputTokens: firstInput + 1 },
			tools: [tool('get_exercise_history', run)],
			steps: [...forever(2), { text: 'Done.' }]
		});
		expect(played.requests).toHaveLength(2);
		expect(played.result).toMatchObject({ outcome: 'budget_exhausted', limit: 'input_tokens' });
		expect(run).toHaveBeenCalledTimes(1);
		expect(played.result.steps).toHaveLength(1);
	});

	it('charges a draft’s tokens to the turn: no later draft or chat call', async () => {
		const drafted: unknown[] = [];
		const admitted: boolean[] = [];
		const run = vi.fn(async (_input: unknown, ctx: ToolContext<Deps>) => {
			for (let i = 0; i < 2; i++) {
				const admit = ctx.drafter!.admit();
				admitted.push(admit);
				if (!admit) continue;
				await ctx.drafter!.onCall!({
					purpose: 'draft',
					kind: 'workout_update',
					requestId: null,
					model: null,
					stopReason: 'end_turn',
					refusalCategory: null,
					usage: { inputTokens: 1, outputTokens: 32_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
					costMicros: 0,
					capCostMicros: 0,
					ttftMs: null,
					latencyMs: 0,
					error: null
				});
			}
			return { value: 1 };
		});
		const played = await play({
			limits: { ...TURN_LIMITS, outputTokens: 32_000 },
			drafter: {
				provider: new MockProvider([], { overrides: () => ({}) }),
				admit: () => true,
				onCall: (call) => void drafted.push(call)
			},
			tools: [tool('update_workout', run)],
			steps: [
				{ tools: [toolCall('update_workout')] },
				{ tools: [toolCall('update_workout')] },
				{ text: 'Done.' }
			]
		});
		expect(admitted).toEqual([true, false]);
		expect(drafted).toHaveLength(1);
		expect(played.requests).toHaveLength(1);
		expect(played.result).toMatchObject({ outcome: 'budget_exhausted', limit: 'output_tokens' });
		expect(played.result.usage.budget.drafts).toBe(1);
		expect(run).toHaveBeenCalledOnce();
	});

	it.each([180, 60])('stops a %i s turn at its deadline, mid-stream', async (seconds) => {
		const limits = turnLimits(seconds);
		const played = await play({
			limits,
			steps: [{ text: 'x'.repeat(16 * 400), delayMs: SECOND }]
		});
		expect(played.result).toMatchObject({ outcome: 'timed_out', stopCause: 'deadline' });
		expect(played.elapsedMs).toBe(limits.turnMs);
		expect(played.text.length).toBeGreaterThan(0);
	});

	it('stops at the endpoint’s deadline when it comes before the loop’s own', async () => {
		const played = await play({
			deadlineInMs: 10 * SECOND,
			steps: [{ text: 'x'.repeat(16 * 400), delayMs: SECOND }]
		});
		expect(played.result).toMatchObject({ outcome: 'timed_out', stopCause: 'deadline' });
		expect(played.elapsedMs).toBe(10 * SECOND);
	});

	it('totals the usage and cost of every call', async () => {
		const played = await play({
			tools: [taking('get_exercise_history', SECOND)],
			steps: [{ tools: [toolCall('get_exercise_history')] }, { text: 'Done.' }]
		});
		const sum = (pick: (message: BetaMessage) => number) =>
			played.messages.reduce((total, message) => total + pick(message), 0);
		expect(played.result.usage).toMatchObject({
			calls: 2,
			inputTokens: sum((m) => m.usage.input_tokens),
			outputTokens: sum((m) => m.usage.output_tokens),
			cacheReadTokens: sum((m) => m.usage.cache_read_input_tokens ?? 0),
			cacheWriteTokens: sum((m) => m.usage.cache_creation_input_tokens ?? 0),
			costMicros: sum((m) => costMicros(modelUsage(m.usage, m.model), m.model)!)
		});
		// The second call reads the prefix the first one wrote.
		expect(played.messages[1]!.usage.cache_read_input_tokens).toBeGreaterThan(0);
		expect(played.result.usage.capCostMicros).toBe(
			played.calls.reduce((total, call) => total + call.capCostMicros, 0)
		);
		expect(played.result.usage.budget).toMatchObject({ chatCalls: 2, exhausted: null });
	});
});

describe('runLoop: cancellation', () => {
	it('stops mid-stream when the client leaves', async () => {
		const played = await play({
			steps: [{ text: 'x'.repeat(16 * 20), delayMs: SECOND }],
			disconnectAfterMs: 5 * SECOND
		});
		expect(played.result).toMatchObject({
			outcome: 'interrupted',
			stopCause: 'disconnected',
			steps: [],
			answer: null
		});
		expect(played.elapsedMs).toBe(5 * SECOND);
		expect(played.text.length).toBe(4 * 16);
	});

	it('keeps running through the disconnect grace period', async () => {
		const played = await play({
			steps: [{ text: 'x'.repeat(16 * 3), delayMs: SECOND }],
			disconnectAfterMs: SECOND,
			disconnectGraceMs: 5 * SECOND
		});
		expect(played.result.outcome).toBe('completed');
	});

	it('answers pending tool_uses as cancelled when stopped mid-tool, and stores the step', async () => {
		const played = await play({
			tools: [taking('get_exercise_history', 8 * SECOND)],
			steps: [{ tools: [toolCall('get_exercise_history')] }, { text: 'never' }],
			disconnectAfterMs: 2 * SECOND
		});
		expect(played.result.outcome).toBe('interrupted');
		expect(played.requests).toHaveLength(1);
		const [step] = played.result.steps;
		expect(resultsOf(step!)).toMatchObject([{ error: 'CANCELLED', is_error: true }]);
		expect(played.persisted).toEqual([step]);
		const replay: BetaMessageParam[] = [
			...played.requests[0]!.messages,
			step!.assistant,
			step!.results
		];
		expect(validateRequest({ ...played.requests[0]!, messages: replay })).toEqual([]);
	});

	it('checks the stored cancel flag between steps', async () => {
		let asked = 0;
		const played = await play({
			tools: [taking('get_exercise_history', SECOND)],
			steps: [{ tools: [toolCall('get_exercise_history')] }, { text: 'never' }],
			cancelRequested: () => ++asked > 1
		});
		expect(played.result).toMatchObject({ outcome: 'cancelled', stopCause: 'cancelled' });
		expect(played.requests).toHaveLength(1);
		expect(played.result.steps).toHaveLength(1);
		expect(asked).toBe(2);
	});
});
