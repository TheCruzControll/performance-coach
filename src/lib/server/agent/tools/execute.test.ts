import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/mini';
import { TURN_LIMITS, turnLimits } from '../../../domain/coach/budgets.ts';
import type { ToolName } from '../../../domain/coach/tools.ts';
import { logger } from '../../observability/logger.ts';
import { ProfileNotFoundError } from '../../services/profile/shared.ts';
import {
	ProgramConflictError,
	TrainingInputError,
	TrainingNotFoundError
} from '../../services/training/shared.ts';
import { validateRequest } from '../provider/validate.ts';
import { toolContext, type ToolContext } from './context.ts';
import { defineTool, type CoachTool } from './define.ts';
import { executeToolCalls, type ToolUseCall } from './execute.ts';
import { page, toolError } from './output.ts';

const OWNER = '00000000-0000-4000-8000-000000000001';
const SECOND = 1000;

interface Deps {
	db: string;
}

let turn: AbortController;

function context(options: { serial?: boolean; leftMs?: number } = {}): ToolContext<Deps> {
	return toolContext({
		session: { ownerId: OWNER },
		message: { threadId: 'thread-1', runId: 'run-1', text: 'How is my squat going?', entry: null },
		day: { today: '2026-11-06', timeZone: 'Europe/London' },
		runtime: {
			deps: { db: options.serial ? 'transaction' : 'pool' },
			serialTools: options.serial ?? false
		},
		signal: turn.signal,
		deadlineAt: Date.now() + (options.leftMs ?? TURN_LIMITS.turnMs),
		matchExercise: () => null
	});
}

const input = z.object({
	exercise: z.optional(z.string().check(z.minLength(1))),
	sets: z.optional(z.array(z.object({ reps: z.int() })))
});
const output = z.object({ value: z.optional(z.number()) });

type Run = (parsed: z.output<typeof input>, ctx: ToolContext<Deps>) => Promise<unknown>;

const tool = (name: ToolName, run: Run): CoachTool<Deps> =>
	defineTool({ name, description: `The ${name} tool.`, input, output, run: run as never });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A tool that takes `ms` and ignores its signal, as a slow service call would. */
const taking = (name: ToolName, ms: number, log: string[] = []) =>
	tool(name, async (_, ctx) => {
		log.push(`start ${name} ${Date.now()}`);
		await sleep(ms);
		log.push(`end ${name} ${Date.now()}`);
		return { value: ms, aborted: ctx.signal.aborted };
	});

const call = (id: string, name: string, toolInput: unknown = {}): ToolUseCall => ({
	id,
	name,
	input: toolInput
});

/** Runs the calls on fake time, long enough for every deadline to pass. */
async function run(calls: ToolUseCall[], ctx: ToolContext<Deps>, tools: CoachTool<Deps>[]) {
	const pending = executeToolCalls(calls, ctx, { tools });
	await vi.advanceTimersByTimeAsync(TURN_LIMITS.turnMs + SECOND);
	return pending;
}

const content = (json: unknown) => JSON.parse(String(json));

beforeEach(() => {
	vi.useFakeTimers({ now: new Date('2026-11-06T09:00:00Z') });
	turn = new AbortController();
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('executeToolCalls', () => {
	it('answers every call in tool_use order, in one user message the API accepts', async () => {
		const tools = [
			taking('get_exercise_history', 3 * SECOND),
			taking('get_personal_records', 1 * SECOND),
			taking('get_recent_workouts', 2 * SECOND)
		];
		const calls = [
			call('toolu_1', 'get_exercise_history'),
			call('toolu_2', 'get_personal_records'),
			call('toolu_3', 'get_weather')
		];
		const { outcomes, message } = await run(calls, context(), tools);

		expect(outcomes.map((o) => [o.toolUseId, o.status])).toEqual([
			['toolu_1', 'succeeded'],
			['toolu_2', 'succeeded'],
			['toolu_3', 'invalid_input']
		]);
		expect(message.role).toBe('user');
		expect(message.content).toEqual([
			{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"aborted":false,"value":3000}' },
			{ type: 'tool_result', tool_use_id: 'toolu_2', content: '{"aborted":false,"value":1000}' },
			{
				type: 'tool_result',
				tool_use_id: 'toolu_3',
				content: '{"error":"UNKNOWN_TOOL","message":"There is no tool with that name"}',
				is_error: true
			}
		]);
		const step: BetaMessageParam[] = [
			{ role: 'user', content: 'How is my squat going?' },
			{ role: 'assistant', content: calls.map((each) => ({ type: 'tool_use', ...each })) },
			message
		];
		expect(
			validateRequest({ max_tokens: 1_000, output_config: { effort: 'medium' }, messages: step })
		).toEqual([]);
	});

	it('refuses a catalogue tool that is not registered yet', async () => {
		const { outcomes } = await run([call('toolu_1', 'get_training_load')], context(), []);
		expect(outcomes[0]).toMatchObject({ status: 'invalid_input', error: { code: 'UNKNOWN_TOOL' } });
	});

	it('never runs a tool on invalid input, and names each bad field by its path', async () => {
		const spy = vi.fn(async () => ({ value: 1 }));
		const { outcomes, message } = await run(
			[
				call('toolu_1', 'get_exercise_history', {
					exercise: '',
					sets: [{ reps: 5 }, { reps: 'x' }]
				})
			],
			context(),
			[tool('get_exercise_history', spy)]
		);
		expect(spy).not.toHaveBeenCalled();
		expect(outcomes[0]).toMatchObject({
			status: 'invalid_input',
			error: { code: 'INVALID_INPUT' }
		});
		const result = content(message.content[0]!.content);
		expect(Object.keys(result.issues)).toEqual(['exercise', 'sets.1.reps']);
		expect(message.content[0]!.is_error).toBe(true);
	});

	it.each([
		[
			'a missing record',
			new TrainingNotFoundError('exercise'),
			'failed',
			{ error: 'NOT_FOUND', message: 'exercise not found' }
		],
		[
			'a missing profile record',
			new ProfileNotFoundError('goal'),
			'failed',
			{ error: 'NOT_FOUND', message: 'goal not found' }
		],
		['a conflict', new ProgramConflictError(), 'failed', { error: 'CONFLICT', reason: 'version' }],
		[
			'input the service refused',
			new TrainingInputError({ weeks: 'At most 12 weeks' }),
			'invalid_input',
			{ error: 'INVALID_INPUT', issues: { weeks: 'At most 12 weeks' } }
		],
		[
			'a failure the tool means',
			toolError('AMBIGUOUS', 'Two exercises match', { candidates: ['Back squat', 'Front squat'] }),
			'failed',
			{ error: 'AMBIGUOUS', candidates: ['Back squat', 'Front squat'] }
		]
	])('returns %s as is_error with its reason', async (_, thrown, status, expected) => {
		const { outcomes, message } = await run([call('toolu_1', 'get_exercise_history')], context(), [
			tool('get_exercise_history', async () => {
				throw thrown;
			})
		]);
		expect(outcomes[0]!.status).toBe(status);
		expect(message.content[0]!.is_error).toBe(true);
		expect(content(message.content[0]!.content)).toMatchObject(expected);
	});

	it('returns anything else as INTERNAL, logged with ids but never shown to the model', async () => {
		const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
		const tools = [
			tool('get_exercise_history', async () => {
				throw new Error('connect ECONNREFUSED 10.0.0.7:5432');
			}),
			tool('get_personal_records', (() => {
				throw new TypeError('synchronous');
			}) as never),
			tool('get_recent_workouts', async () => ({ at: new Date(0) }))
		];
		const calls = [
			call('toolu_1', 'get_exercise_history'),
			call('toolu_2', 'get_personal_records'),
			call('toolu_3', 'get_recent_workouts')
		];
		const { outcomes, message } = await run(calls, context(), tools);
		expect(outcomes.map((o) => o.error?.code)).toEqual(['INTERNAL', 'INTERNAL', 'INTERNAL']);
		expect(JSON.stringify(message)).not.toMatch(/ECONNREFUSED|10\.0\.0\.7|synchronous/);
		expect(error).toHaveBeenCalledTimes(3);
		expect(error).toHaveBeenCalledWith(
			'coach tool failed',
			expect.objectContaining({
				tool: 'get_exercise_history',
				toolUseId: 'toolu_1',
				runId: 'run-1'
			})
		);
	});

	it('caps a large result and says it was truncated', async () => {
		const items = Array.from({ length: 20 }, (_, i) => ({ id: `w-${i}`, text: 'x'.repeat(600) }));
		const { outcomes, message } = await run([call('toolu_1', 'get_recent_workouts')], context(), [
			tool('get_recent_workouts', async () => page(items))
		]);
		expect(outcomes[0]).toMatchObject({ status: 'succeeded', truncated: true });
		expect(
			new TextEncoder().encode(String(message.content[0]!.content)).length
		).toBeLessThanOrEqual(8 * 1024);
		expect(content(message.content[0]!.content)).toMatchObject({ truncated: true, more: true });
	});

	it('acts on the session’s owner, whatever the input says', async () => {
		const seen: unknown[] = [];
		const { outcomes } = await run(
			[call('toolu_1', 'get_exercise_history', { exercise: 'Squat', ownerId: 'someone-else' })],
			context(),
			[
				tool('get_exercise_history', async (parsed, ctx) => {
					seen.push(parsed, ctx.ownerId, ctx.deps);
					return { value: 1 };
				})
			]
		);
		expect(outcomes[0]!.status).toBe('succeeded');
		expect(seen).toEqual([{ exercise: 'Squat' }, OWNER, { db: 'pool' }]);
	});
});

describe('concurrency', () => {
	const names: ToolName[] = [
		'get_exercise_history',
		'get_personal_records',
		'get_recent_workouts',
		'get_running_history'
	];
	const calls = names.map((name, i) => call(`toolu_${i + 1}`, name));

	it('runs three at a time on the pool', async () => {
		const log: string[] = [];
		await run(
			calls.slice(0, 3),
			context(),
			names.map((name) => taking(name, SECOND, log))
		);
		const start = Date.parse('2026-11-06T09:00:00Z');
		expect(
			log
				.filter((line) => line.startsWith('start'))
				.map((line) => Number(line.split(' ')[2]) - start)
		).toEqual([0, 0, 0]);

		log.length = 0;
		await run(
			calls,
			context(),
			names.map((name) => taking(name, SECOND, log))
		);
		const starts = log.filter((line) => line.startsWith('start')).map((line) => line.split(' ')[1]);
		expect(starts).toEqual(names);
		expect(log[3]).toMatch(/^end /);
	});

	it('runs one at a time on a transaction, each after the last has finished', async () => {
		const log: string[] = [];
		const { outcomes } = await run(
			calls.slice(0, 3),
			context({ serial: true }),
			names.map((name) => taking(name, SECOND, log))
		);
		expect(log.map((line) => line.split(' ').slice(0, 2).join(' '))).toEqual([
			'start get_exercise_history',
			'end get_exercise_history',
			'start get_personal_records',
			'end get_personal_records',
			'start get_recent_workouts',
			'end get_recent_workouts'
		]);
		expect(outcomes.every((o) => o.status === 'succeeded')).toBe(true);
	});

	it('on a transaction, waits for a timed-out call to finish before the next starts', async () => {
		const log: string[] = [];
		const begin = Date.now();
		const { outcomes } = await run(
			[call('toolu_1', 'get_exercise_history'), call('toolu_2', 'get_personal_records')],
			context({ serial: true }),
			[
				taking('get_exercise_history', 12 * SECOND, log),
				taking('get_personal_records', SECOND, log)
			]
		);
		expect(outcomes[0]).toMatchObject({ status: 'timed_out', durationMs: 10 * SECOND });
		expect(log).toEqual([
			`start get_exercise_history ${begin}`,
			`end get_exercise_history ${begin + 12 * SECOND}`,
			`start get_personal_records ${begin + 12 * SECOND}`,
			`end get_personal_records ${begin + 13 * SECOND}`
		]);
	});
});

describe('deadlines', () => {
	it('stops a reading tool after 10 s', async () => {
		const { outcomes, message } = await run([call('toolu_1', 'get_exercise_history')], context(), [
			taking('get_exercise_history', 12 * SECOND)
		]);
		expect(outcomes[0]).toMatchObject({
			status: 'timed_out',
			durationMs: 10 * SECOND,
			error: { code: 'TIMEOUT' }
		});
		expect(message.content[0]).toMatchObject({ is_error: true });
	});

	it('lets a drafting tool run past 10 s, and stops it after its tool and draft time', async () => {
		expect(TURN_LIMITS.toolMs + TURN_LIMITS.draftMs).toBe(85 * SECOND);
		const drafted = await run([call('toolu_1', 'update_workout')], context(), [
			taking('update_workout', 12 * SECOND)
		]);
		expect(drafted.outcomes[0]).toMatchObject({
			status: 'succeeded',
			output: { value: 12 * SECOND }
		});

		const stuck = await run([call('toolu_1', 'update_workout')], context(), [
			taking('update_workout', 90 * SECOND)
		]);
		expect(stuck.outcomes[0]).toMatchObject({ status: 'timed_out', durationMs: 85 * SECOND });
	});

	it('never lets a drafting tool outlast the turn', async () => {
		const { outcomes } = await run(
			[call('toolu_1', 'update_workout')],
			context({ leftMs: 8 * SECOND }),
			[taking('update_workout', 12 * SECOND)]
		);
		expect(outcomes[0]).toMatchObject({ status: 'timed_out', durationMs: 8 * SECOND });
	});

	it('gives each call its own signal and deadline, and tells the tool when it is out of time', async () => {
		let seen: ToolContext<Deps> | undefined;
		const tools = [
			tool('get_exercise_history', async (_, ctx) => {
				seen = ctx;
				await sleep(11 * SECOND);
				return { value: 1 };
			})
		];
		const ctx = context();
		const begin = Date.now();
		await run([call('toolu_1', 'get_exercise_history')], ctx, tools);
		expect(seen!.deadlineAt).toBe(begin + 10 * SECOND);
		expect(seen!.signal).not.toBe(ctx.signal);
		expect(seen!.signal.aborted).toBe(true);
		expect(ctx.signal.aborted).toBe(false);
	});

	it('does not start a tool when the turn has no time left', async () => {
		const spy = vi.fn(async () => ({ value: 1 }));
		const { outcomes } = await run(
			[call('toolu_1', 'get_exercise_history')],
			context({ leftMs: 0 }),
			[tool('get_exercise_history', spy)]
		);
		expect(spy).not.toHaveBeenCalled();
		expect(outcomes[0]).toMatchObject({ status: 'timed_out' });
	});

	it('reads its limits from the turn limits it is given', async () => {
		const limits = turnLimits(60);
		const pending = executeToolCalls([call('toolu_1', 'update_workout')], context(), {
			tools: [taking('update_workout', 40 * SECOND)],
			limits
		});
		await vi.advanceTimersByTimeAsync(60 * SECOND);
		expect((await pending).outcomes[0]).toMatchObject({
			status: 'timed_out',
			durationMs: 25 * SECOND
		});
	});
});

describe('cancellation', () => {
	it('answers every call as cancelled when the turn is stopped, and runs none after', async () => {
		const log: string[] = [];
		const tools = [
			taking('get_exercise_history', 5 * SECOND, log),
			taking('get_personal_records', SECOND, log)
		];
		const pending = executeToolCalls(
			[call('toolu_1', 'get_exercise_history'), call('toolu_2', 'get_personal_records')],
			context({ serial: true }),
			{ tools }
		);
		await vi.advanceTimersByTimeAsync(2 * SECOND);
		turn.abort();
		await vi.advanceTimersByTimeAsync(10 * SECOND);
		const { outcomes, message } = await pending;
		expect(outcomes.map((o) => [o.status, o.error?.code])).toEqual([
			['cancelled', 'CANCELLED'],
			['cancelled', 'CANCELLED']
		]);
		expect(outcomes[0]!.durationMs).toBe(2 * SECOND);
		expect(log.some((line) => line.startsWith('start get_personal_records'))).toBe(false);
		expect(message.content.every((block) => block.is_error)).toBe(true);
	});

	it.each([
		['while its tool runs', 5 * SECOND, 2 * SECOND, 'cancelled'],
		['while it waits out a timed-out tool', 12 * SECOND, 11 * SECOND, 'timed_out']
	])(
		'on a transaction, returns only once the stopped tool has finished, when stopped %s',
		async (_, toolMs, stopAt, status) => {
			const log: string[] = [];
			const begin = Date.now();
			let returnedAt: number | undefined;
			const pending = executeToolCalls(
				[call('toolu_1', 'get_exercise_history'), call('toolu_2', 'get_personal_records')],
				context({ serial: true }),
				{
					tools: [
						taking('get_exercise_history', toolMs, log),
						taking('get_personal_records', SECOND, log)
					]
				}
			).finally(() => (returnedAt = Date.now()));
			await vi.advanceTimersByTimeAsync(stopAt);
			turn.abort();
			await vi.advanceTimersByTimeAsync(TURN_LIMITS.turnMs);
			const { outcomes } = await pending;
			expect(outcomes.map((o) => o.status)).toEqual([status, 'cancelled']);
			// The caller's next query (the cancelled results) goes to the same connection.
			expect(returnedAt).toBe(begin + toolMs);
			expect(log).toEqual([
				`start get_exercise_history ${begin}`,
				`end get_exercise_history ${begin + toolMs}`
			]);
		}
	);
});
