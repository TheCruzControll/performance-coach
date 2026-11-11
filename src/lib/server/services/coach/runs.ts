/**
 * Coach runs (M5, PRD §12, §15): what every turn did and cost, recorded as it happens and read
 * back for the daily cap, Stop and the usage view.
 *
 * - One live run per conversation: startRun refuses a second (CoachBusyError) and first expires a
 *   run left running past TURN_LIMITS.staleRunMs, whose endpoint can no longer be alive.
 * - Every model call stores its tokens, served model, stop reason, refusal category, timings and
 *   two prices (domain/coach/pricing.ts): cost_micros, null for a model with no price, and
 *   cap_cost_micros, which prices such a model at the highest known rate. Each call also adds
 *   both to its run in the same transaction, so a run's totals are its calls' sums.
 * - The daily cap counts cap_cost_micros, so it can never be passed through an unpriced model.
 * - A run records and changes nothing once it has finished (CoachRunFinishedError).
 * Every function is owner-scoped: someone else's run is not found, like a missing one.
 */
import { TURN_LIMITS } from '../../../domain/coach/budgets';
import {
	capCostMicros,
	costMicros,
	usageTotals,
	type ModelUsage,
	type TokenUsage
} from '../../../domain/coach/pricing';
import {
	RUN_STATUSES,
	type RunStatus,
	type ToolCallStatus
} from '../../../domain/coach/vocabulary';
import { createAgentRunsRepository, type RunRow } from '../../db/repositories/agent-runs';
import { TOOL_CALL_JSON_MAX_BYTES } from '../../db/schema/agent-runs';
import type { Executor } from '../../db/types';
import { isUuid } from '../ids';
import {
	CoachBusyError,
	CoachInputError,
	CoachNotFoundError,
	CoachRunFinishedError,
	resolveDeps,
	type CoachDeps
} from './shared';

export type CoachRun = RunRow;

/** Runs per page of the usage view: the default and the most a caller may ask for. */
export const RUN_PAGE = Object.freeze({ default: 20, max: 50 });

/** How a run may finish. 'expired' is startRun's alone: an abandoned run. */
export type RunEnd = Exclude<RunStatus, 'running' | 'expired'>;
const RUN_ENDS = RUN_STATUSES.filter((s) => s !== 'running' && s !== 'expired');

function runId(id: string): string {
	if (!isUuid(id)) throw new CoachNotFoundError('run');
	return id;
}

/** Why a running run's write found nothing: not the owner's, or already finished. */
async function notRunning(db: Executor, ownerId: string, id: string): Promise<never> {
	if (await createAgentRunsRepository(db).run(ownerId, id)) throw new CoachRunFinishedError();
	throw new CoachNotFoundError('run');
}

export interface StartRunInput {
	threadId: string;
	/** The owner message the run answers; a retry is a new run on the same message. */
	triggerMessageId: string;
	kind: string;
	provider: string;
	model: string;
	effort: string;
	promptVersion: string;
}

/**
 * Start a run on a conversation's owner message. A run still live on the conversation refuses it
 * (CoachBusyError); one started more than TURN_LIMITS.staleRunMs ago is expired first.
 */
export async function startRun(
	ownerId: string,
	input: StartRunInput,
	deps: CoachDeps = {}
): Promise<CoachRun> {
	const { db, now } = resolveDeps(deps);
	const repo = createAgentRunsRepository(db);
	const { threadId, triggerMessageId } = input;
	if (
		!isUuid(threadId) ||
		!isUuid(triggerMessageId) ||
		!(await repo.hasOwnerMessage(ownerId, threadId, triggerMessageId))
	) {
		throw new CoachNotFoundError('message');
	}
	const at = now();
	const live = await repo.runningRun(ownerId, threadId);
	if (live) {
		const cutoff = new Date(at.getTime() - TURN_LIMITS.staleRunMs);
		if (live.startedAt > cutoff) throw new CoachBusyError();
		await repo.expireRun(ownerId, live.id, cutoff, at);
	}
	// A concurrent start that won the partial unique index makes this one busy.
	const run = await repo.insertRun({ ...input, ownerId, status: 'running', startedAt: at });
	if (!run) throw new CoachBusyError();
	return run;
}

/**
 * The run still live on one of the owner's conversations, or null: none is running, or the one
 * running started more than TURN_LIMITS.staleRunMs ago (startRun expires it).
 */
export async function liveRun(
	ownerId: string,
	threadId: string,
	deps: CoachDeps = {}
): Promise<{ id: string; startedAt: Date } | null> {
	const { db, now } = resolveDeps(deps);
	if (!isUuid(threadId)) return null;
	const live = await createAgentRunsRepository(db).runningRun(ownerId, threadId);
	if (!live || live.startedAt.getTime() <= now().getTime() - TURN_LIMITS.staleRunMs) return null;
	return live;
}

export interface ModelCallInput {
	/** The run's calls in order, from 0, failed and re-issued ones included. */
	index: number;
	requestId: string | null;
	/** The model that served it (a fallback's when one took over); null if it failed first. */
	model: string | null;
	stopReason: string | null;
	/** The API's stop_details; its category is read on a refusal only. */
	stopDetails?: { category?: string | null } | null;
	usage: ModelUsage;
	ttftMs: number | null;
	latencyMs: number;
	/** The provider error kind; never message text. */
	error: string | null;
}

const isZero = (t: TokenUsage) =>
	t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens === 0;

/** Both prices of a call; a call that used no tokens costs nothing, served or not. */
function prices(usage: ModelUsage, tokens: TokenUsage, model: string | null) {
	if (isZero(tokens)) return { costMicros: 0, capCostMicros: 0 };
	return {
		costMicros: costMicros(usage, model ?? ''),
		capCostMicros: capCostMicros(usage, model ?? '')
	};
}

/** Record one model call of a running run, priced, and add it to the run's totals. */
export async function recordModelCall(
	ownerId: string,
	id: string,
	call: ModelCallInput,
	deps: CoachDeps = {}
): Promise<{ costMicros: number | null; capCostMicros: number }> {
	const { db, now } = resolveDeps(deps);
	runId(id);
	const tokens = usageTotals(call.usage);
	const cost = prices(call.usage, tokens, call.model);
	const refusalCategory =
		call.stopReason === 'refusal' ? (call.stopDetails?.category ?? null) : null;
	return db.transaction(async (tx) => {
		const repo = createAgentRunsRepository(tx);
		const rolled = await repo.rollUp(ownerId, id, {
			...tokens,
			...cost,
			servedModel: call.model,
			stopReason: call.stopReason,
			refusalCategory
		});
		if (!rolled) return notRunning(tx, ownerId, id);
		await repo.insertModelCall({
			ownerId,
			runId: id,
			callIndex: call.index,
			requestId: call.requestId,
			model: call.model,
			stopReason: call.stopReason,
			refusalCategory,
			error: call.error,
			...tokens,
			...cost,
			ttftMs: call.ttftMs,
			latencyMs: call.latencyMs,
			createdAt: now()
		});
		return cost;
	});
}

export interface ToolCallInput {
	/** The model call whose tool_use it answers. */
	callIndex: number;
	toolUseId: string;
	name: string;
	status: ToolCallStatus;
	input: unknown;
	output: unknown;
	errorCode: string | null;
	truncated: boolean;
	proposalId?: string | null;
	startedAt: Date;
	durationMs: number;
}

/**
 * A value as stored, cut to a marker when its JSON may pass TOOL_CALL_JSON_MAX_BYTES. One space of
 * indentation over-counts the separators Postgres adds when jsonb is cast to text.
 */
function capped(value: unknown): { value: unknown; cut: boolean } {
	const bytes = new TextEncoder().encode(JSON.stringify(value, null, 1) ?? 'null').length;
	return bytes <= TOOL_CALL_JSON_MAX_BYTES
		? { value, cut: false }
		: { value: { truncated: true, bytes }, cut: true };
}

/** Record a step's tool calls (and output-policy '_policy' rows) on a running run. */
export async function recordToolCalls(
	ownerId: string,
	id: string,
	calls: readonly ToolCallInput[],
	deps: CoachDeps = {}
): Promise<void> {
	const { db } = resolveDeps(deps);
	runId(id);
	if (calls.length === 0) return;
	await db.transaction(async (tx) => {
		const repo = createAgentRunsRepository(tx);
		if (!(await repo.addToolCalls(ownerId, id, calls.length))) return notRunning(tx, ownerId, id);
		await repo.insertToolCalls(
			calls.map(({ input, output, truncated, proposalId, ...call }) => {
				const storedInput = capped(input);
				const storedOutput = output == null ? { value: null, cut: false } : capped(output);
				return {
					...call,
					ownerId,
					runId: id,
					input: storedInput.value,
					output: storedOutput.value,
					truncated: truncated || storedInput.cut || storedOutput.cut,
					proposalId: proposalId ?? null
				};
			})
		);
	});
}

/** Finish a running run, once; its latency runs from its start to now. */
export async function finishRun(
	ownerId: string,
	id: string,
	end: { status: RunEnd; error?: string | null; ttftMs?: number | null },
	deps: CoachDeps = {}
): Promise<CoachRun> {
	const { db, now } = resolveDeps(deps);
	runId(id);
	if (!RUN_ENDS.includes(end.status)) {
		throw new CoachInputError('status', `A run cannot finish as '${end.status}'`);
	}
	const row = await createAgentRunsRepository(db).finish(ownerId, id, now(), {
		status: end.status,
		error: end.error ?? null,
		ttftMs: end.ttftMs ?? null
	});
	return row ?? notRunning(db, ownerId, id);
}

/**
 * Stop: flag a running run; the loop reads the flag between steps. True while the run is running
 * with its flag set (again is a no-op), false when it has already finished.
 */
export async function requestCancel(
	ownerId: string,
	id: string,
	deps: CoachDeps = {}
): Promise<boolean> {
	const { db, now } = resolveDeps(deps);
	const repo = createAgentRunsRepository(db);
	if (await repo.requestCancel(ownerId, runId(id), now())) return true;
	const run = await repo.run(ownerId, id);
	if (!run) throw new CoachNotFoundError('run');
	return run.status === 'running';
}

export async function isCancelRequested(
	ownerId: string,
	id: string,
	deps: CoachDeps = {}
): Promise<boolean> {
	const { db } = resolveDeps(deps);
	const run = await createAgentRunsRepository(db).run(ownerId, runId(id));
	if (!run) throw new CoachNotFoundError('run');
	return run.cancelRequestedAt !== null;
}

/**
 * The prompt the run's last served call sent, in tokens (input, cache reads and cache writes):
 * how long its conversation segment had grown. Calls numbered at or past `below` (a turn's drafts)
 * are other prompts and passed over. Null when the run has no such call.
 */
export async function lastCallInputTokens(
	ownerId: string,
	id: string,
	{ below }: { below: number },
	deps: CoachDeps = {}
): Promise<number | null> {
	const { db } = resolveDeps(deps);
	if (!isUuid(id)) return null;
	return createAgentRunsRepository(db).lastCallInput(ownerId, id, below);
}

/**
 * What the daily cap counts: the cap cost of every model call made since midnight in the owner's
 * time zone (their profile's, UTC without one), in micro-dollars.
 */
export async function spentToday(ownerId: string, deps: CoachDeps = {}): Promise<number> {
	const { db, now } = resolveDeps(deps);
	return createAgentRunsRepository(db).dayCapCost(ownerId, now(), TURN_LIMITS.staleRunMs);
}

export interface UsageSummary {
	runs: number;
	modelCalls: number;
	toolCalls: number;
	tokens: TokenUsage;
	/** The priced runs' cost; unpriced runs are counted in unpricedRuns instead. */
	costMicros: number;
	/** What the cap counted, unpriced runs at the highest known rate. */
	capCostMicros: number;
	unpricedRuns: number;
	unpricedCalls: number;
	/** Cache reads over every prompt token; null before any. */
	cacheHitRatio: number | null;
	/** Finished runs' latency; null before any. */
	latencyMs: { p50: number | null; p95: number | null };
	statuses: Record<RunStatus, number>;
	/** Each tool's calls, most first, then by name. */
	tools: { name: string; calls: number }[];
}

/** The owner's coach usage across every run, for diagnostics. */
export async function usageSummary(ownerId: string, deps: CoachDeps = {}): Promise<UsageSummary> {
	const { db } = resolveDeps(deps);
	const repo = createAgentRunsRepository(db);
	const t = await repo.runTotals(ownerId);
	const counted = await repo.statusCounts(ownerId);
	const tools = await repo.toolFrequency(ownerId);
	const unpricedCalls = await repo.unpricedCalls(ownerId);
	const tokens = {
		inputTokens: t.inputTokens,
		outputTokens: t.outputTokens,
		cacheReadTokens: t.cacheReadTokens,
		cacheWriteTokens: t.cacheWriteTokens
	};
	const prompt = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
	const statuses = Object.fromEntries(RUN_STATUSES.map((s) => [s, 0])) as Record<RunStatus, number>;
	for (const { status, runs } of counted) statuses[status] = runs;
	return {
		runs: t.runs,
		modelCalls: t.modelCalls,
		toolCalls: t.toolCalls,
		tokens,
		costMicros: t.costMicros,
		capCostMicros: t.capCostMicros,
		unpricedRuns: t.unpricedRuns,
		unpricedCalls,
		cacheHitRatio: prompt === 0 ? null : t.cacheReadTokens / prompt,
		latencyMs: { p50: t.latencyP50Ms, p95: t.latencyP95Ms },
		statuses,
		tools
	};
}

/** A page of the owner's runs, newest first; `nextBefore` continues it, null at its end. */
export async function listRuns(
	ownerId: string,
	{ before, limit = RUN_PAGE.default }: { before?: string; limit?: number } = {},
	deps: CoachDeps = {}
): Promise<{ runs: CoachRun[]; nextBefore: string | null }> {
	const { db } = resolveDeps(deps);
	if (!(Number.isInteger(limit) && limit >= 1 && limit <= RUN_PAGE.max)) {
		throw new CoachInputError('limit', `A page holds 1 to ${RUN_PAGE.max} runs`);
	}
	if (before !== undefined && !isUuid(before)) {
		throw new CoachInputError('before', 'A page continues from a run id');
	}
	const rows = await createAgentRunsRepository(db).runPage(ownerId, { before, limit: limit + 1 });
	const runs = rows.slice(0, limit);
	return { runs, nextBefore: rows.length > limit ? runs.at(-1)!.id : null };
}
