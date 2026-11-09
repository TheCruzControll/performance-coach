/**
 * Runs one step's tool calls and answers them all in one user message, in tool_use order (the
 * claude-api skill: split results teach the model to stop calling tools in parallel). Every path
 * ends in a tool_result; every failure is an is_error result the model can act on:
 * - UNKNOWN_TOOL; INVALID_INPUT with each issue under its dotted path, and the tool never runs
 *   (eager input streaming means the API no longer checks the input, so this does)
 * - TIMEOUT past toolDeadlineMs (a drafting tool also gets its draft's time, never past the
 *   turn); CANCELLED when the turn stops
 * - NOT_FOUND, CONFLICT with its reason, INVALID_INPUT: the services' errors; a tool's own
 *   toolError; TOO_LARGE from capOutput
 * - INTERNAL for anything else, logged with ids only and never shown to the model
 *
 * Tools run TURN_LIMITS.concurrency at a time, or one at a time when ctx.serialTools says the
 * services hold a transaction. A transaction runs one query at a time and services take no
 * signal, so there a call that timed out or was cancelled holds the connection until its query
 * ends: the next call waits for it, and so does the return, because the caller's next query (the
 * step's results) uses the same connection. On the pool a stopped turn returns at once.
 */
import type {
	BetaToolResultBlockParam,
	BetaToolUseBlock
} from '@anthropic-ai/sdk/resources/beta/messages';
import { toolDeadlineMs, TURN_LIMITS, type TurnLimits } from '../../../domain/coach/budgets.ts';
import type { ToolCallStatus } from '../../../domain/coach/vocabulary.ts';
import { canonicalJson } from '../../../domain/programming/random.ts';
import { validate } from '../../../domain/validation.ts';
import { logger } from '../../observability/logger.ts';
import { ProfileInputError, ProfileNotFoundError } from '../../services/profile/shared.ts';
import {
	ConflictError,
	TrainingInputError,
	TrainingNotFoundError
} from '../../services/training/shared.ts';
import type { ToolContext } from './context.ts';
import type { CoachTool } from './define.ts';
import { capOutput, ToolError } from './output.ts';
import { COACH_TOOLS } from './registry.ts';

export type ToolUseCall = Pick<BetaToolUseBlock, 'id' | 'name' | 'input'>;

export interface ToolCallOutcome {
	toolUseId: string;
	/** As the model asked for it, which may be no tool's name. */
	name: string;
	status: ToolCallStatus;
	/** What the model received on success (the capped output); null on failure. */
	output: unknown;
	/** The tool_result's content, as canonical JSON. */
	content: string;
	error: { code: string; message: string } | null;
	truncated: boolean;
	startedAt: number;
	durationMs: number;
}

export interface ExecutedToolCalls {
	outcomes: ToolCallOutcome[];
	message: { role: 'user'; content: BetaToolResultBlockParam[] };
}

type Result =
	| { ok: true; output: unknown; content: string; truncated: boolean }
	| { ok: false; code: string; message: string; content: string };

const STATUS: Record<string, ToolCallStatus> = {
	UNKNOWN_TOOL: 'invalid_input',
	INVALID_INPUT: 'invalid_input',
	TIMEOUT: 'timed_out',
	CANCELLED: 'cancelled'
};

function failure(code: string, message: string, details: Record<string, unknown> = {}): Result {
	let content: string;
	try {
		content = canonicalJson({ ...details, error: code, message });
	} catch {
		content = canonicalJson({ error: code, message });
	}
	return { ok: false, code, message, content };
}

const cancelled = () => failure('CANCELLED', 'The turn was stopped before this tool finished');
const timedOut = (ms: number) =>
	failure('TIMEOUT', `The tool ran out of time (${Math.round(ms / 1000)} s)`);

function fromError(error: unknown, call: ToolUseCall, runId: string): Result {
	if (error instanceof ToolError) return failure(error.code, error.message, { ...error.details });
	if (error instanceof TrainingNotFoundError || error instanceof ProfileNotFoundError)
		return failure('NOT_FOUND', error.message);
	if (error instanceof TrainingInputError || error instanceof ProfileInputError)
		return failure('INVALID_INPUT', 'The service refused the input', { issues: error.errors });
	if (error instanceof ConflictError)
		return failure('CONFLICT', error.message, { reason: error.reason });
	logger.error('coach tool failed', { tool: call.name, toolUseId: call.id, runId, err: error });
	return failure('INTERNAL', 'The tool failed; answer without it or try again');
}

function succeeded(value: unknown, call: ToolUseCall, runId: string): Result {
	try {
		const capped = capOutput(value);
		return { ok: true, output: capped.value, content: capped.json, truncated: capped.truncated };
	} catch (error) {
		return fromError(error, call, runId);
	}
}

/** One call's result, and when its tool has really stopped (later than the result on a timeout). */
async function runCall<Deps>(
	call: ToolUseCall,
	tool: CoachTool<Deps> | undefined,
	ctx: ToolContext<Deps>,
	limits: TurnLimits
): Promise<[Result, Promise<unknown>?]> {
	if (!tool) return [failure('UNKNOWN_TOOL', 'There is no tool with that name')];
	if (ctx.signal.aborted) return [cancelled()];
	const input = validate(tool.inputSchema, call.input);
	if (!input.ok) {
		const message = 'The input does not match the tool’s schema';
		return [failure('INVALID_INPUT', message, { issues: input.errors })];
	}
	const startedAt = Date.now();
	const allowedMs = toolDeadlineMs(tool.entry, ctx.deadlineAt - startedAt, limits);
	if (allowedMs <= 0) return [timedOut(allowedMs)];

	const controller = new AbortController();
	let outOfTime = false;
	const stopTurn = () => controller.abort(ctx.signal.reason);
	ctx.signal.addEventListener('abort', stopTurn, { once: true });
	const timer = setTimeout(() => {
		outOfTime = true;
		controller.abort(new DOMException('The tool ran out of time', 'TimeoutError'));
	}, allowedMs);
	const stopped = new Promise<'stopped'>((resolve) =>
		controller.signal.addEventListener('abort', () => resolve('stopped'), { once: true })
	);
	const callCtx = Object.freeze({
		...ctx,
		toolUseId: call.id,
		signal: controller.signal,
		deadlineAt: startedAt + allowedMs
	});
	const work = Promise.resolve().then(() => tool.run(input.data, callCtx));
	try {
		const first = await Promise.race([
			work.then(
				(value) => ({ value }),
				(error: unknown) => ({ error })
			),
			stopped
		]);
		if (first === 'stopped')
			return [outOfTime ? timedOut(allowedMs) : cancelled(), work.catch(() => undefined)];
		if ('error' in first) return [fromError(first.error, call, ctx.runId)];
		return [succeeded(first.value, call, ctx.runId)];
	} finally {
		clearTimeout(timer);
		ctx.signal.removeEventListener('abort', stopTurn);
	}
}

export async function executeToolCalls<Deps>(
	calls: readonly ToolUseCall[],
	ctx: ToolContext<Deps>,
	options: { tools?: readonly CoachTool<Deps>[]; limits?: TurnLimits } = {}
): Promise<ExecutedToolCalls> {
	const registered = options.tools ?? (COACH_TOOLS as readonly CoachTool<Deps>[]);
	const tools = new Map(registered.map((tool) => [tool.name as string, tool]));
	const limits = options.limits ?? TURN_LIMITS;
	const outcomes: ToolCallOutcome[] = [];
	let next = 0;
	const worker = async () => {
		for (let index = next++; index < calls.length; index = next++) {
			const call = calls[index]!;
			const startedAt = Date.now();
			const [result, settled] = await runCall(call, tools.get(call.name), ctx, limits);
			outcomes[index] = {
				toolUseId: call.id,
				name: call.name,
				status: result.ok ? 'succeeded' : (STATUS[result.code] ?? 'failed'),
				output: result.ok ? result.output : null,
				content: result.content,
				error: result.ok ? null : { code: result.code, message: result.message },
				truncated: result.ok && result.truncated,
				startedAt,
				durationMs: Date.now() - startedAt
			};
			if (ctx.serialTools && settled) await settled;
		}
	};
	const width = Math.min(ctx.serialTools ? 1 : limits.concurrency, calls.length);
	await Promise.all(Array.from({ length: width }, worker));
	const content = outcomes.map(({ toolUseId, content, status }) => ({
		type: 'tool_result' as const,
		tool_use_id: toolUseId,
		content,
		...(status === 'succeeded' ? {} : { is_error: true })
	}));
	return { outcomes, message: { role: 'user', content } };
}
