/**
 * Every limit on a coach turn, derived from one duration constant, plus the daily cap and when a
 * segment is summarised. The turn endpoint, the agent loop, the tool runner, the drafter and the
 * stale-run sweep all read them from here.
 *
 * Time: the endpoint may run COACH_MAX_DURATION_S. A turn stops 30 s before that, so it can
 * still store its last step and say why it stopped; a run left 'running' 30 s after that is
 * stale. A tool gets 10 s, and a drafting tool also gets its draft's time, never past what is left
 * of the turn.
 *
 * Tokens and calls: at most 8 chat calls and 2 drafts per turn, 40K output tokens and 300K input
 * tokens. Input counts every prompt token a call sent, cached or not, as the segment rule does: it
 * bounds the turn's latency and context as well as its cost.
 */
import { usageTotals, type ModelUsage } from './pricing.ts';
import type { ToolCatalogueEntry } from './tools.ts';

/**
 * The turn endpoint's maxDuration on Vercel; every time limit below derives from it.
 * Owner decision (open question): 180 s needs Fluid compute on the Hobby plan. The fallback is
 * 60 s, which turnLimits(60) proves still works: 30 s turns, 15 s drafts, 25 s drafting tools.
 */
export const COACH_MAX_DURATION_S = 180;

/** Owner decision (open question): the most the coach may spend in one of the owner's days. */
export const DAILY_COST_CAP_USD = 5;

export interface TurnLimits {
	turnMs: number;
	draftMs: number;
	toolMs: number;
	staleRunMs: number;
	chatCalls: number;
	drafts: number;
	maxTokens: { chat: number; draft: number; summary: number };
	outputTokens: number;
	inputTokens: number;
	/** Tools run at once on the pool (one at a time on a transaction). */
	concurrency: number;
	toolOutputBytes: number;
}

export interface DailyLimits {
	costMicros: number;
}

/** A segment becomes a summary when its last call's input reaches this, or at this many messages. */
export interface SegmentLimits {
	inputTokens: number;
	messages: number;
}

const SECOND = 1000;
/** The margin between the turn and the endpoint's end, and between that end and a stale run. */
const MARGIN_MS = 30 * SECOND;
const TOOL_MS = 10 * SECOND;
const MAX_DRAFT_MS = 75 * SECOND;

/**
 * The limits for an endpoint that may run `maxDurationS`. A duration too short for a drafting tool
 * to fit inside the turn (under 50 s) is refused.
 */
export function turnLimits(maxDurationS: number): TurnLimits {
	const turnMs = maxDurationS * SECOND - MARGIN_MS;
	const draftMs = Math.min(MAX_DRAFT_MS, Math.floor(turnMs / 2));
	if (!Number.isInteger(maxDurationS) || TOOL_MS + draftMs > turnMs)
		throw new RangeError(`A ${maxDurationS} s coach turn cannot fit a drafting tool`);
	return Object.freeze({
		turnMs,
		draftMs,
		toolMs: TOOL_MS,
		staleRunMs: maxDurationS * SECOND + MARGIN_MS,
		chatCalls: 8,
		drafts: 2,
		maxTokens: Object.freeze({ chat: 16_000, draft: 32_000, summary: 8_000 }),
		outputTokens: 40_000,
		inputTokens: 300_000,
		concurrency: 3,
		toolOutputBytes: 8 * 1024
	});
}

export const TURN_LIMITS: TurnLimits = turnLimits(COACH_MAX_DURATION_S);
export const DAILY_LIMITS: DailyLimits = Object.freeze({
	costMicros: DAILY_COST_CAP_USD * 1_000_000
});
export const SEGMENT: SegmentLimits = Object.freeze({ inputTokens: 60_000, messages: 40 });

export type TurnLimit = 'chat_calls' | 'drafts' | 'input_tokens' | 'output_tokens';

export interface TurnBudget {
	chatCalls: number;
	drafts: number;
	inputTokens: number;
	outputTokens: number;
	/** The first limit the turn reached, or null while it may make another call. */
	exhausted: TurnLimit | null;
}

/** Before the turn's first call. */
export const TURN_BUDGET_START: TurnBudget = Object.freeze({
	chatCalls: 0,
	drafts: 0,
	inputTokens: 0,
	outputTokens: 0,
	exhausted: null
});

/** How long a tool may run: a drafting tool gets its draft's time too, never past the turn. */
export function toolDeadlineMs(
	entry: Pick<ToolCatalogueEntry, 'drafts'>,
	remainingMs: number,
	limits: TurnLimits = TURN_LIMITS
): number {
	const own = entry.drafts ? limits.toolMs + limits.draftMs : limits.toolMs;
	return Math.max(0, Math.min(remainingMs, own));
}

/** A limit that ends the turn. Spent drafts do not: the turn can still answer (blockingLimit). */
function turnEndingLimit(budget: Omit<TurnBudget, 'exhausted'>, limits: TurnLimits) {
	if (budget.chatCalls >= limits.chatCalls) return 'chat_calls';
	if (budget.inputTokens >= limits.inputTokens) return 'input_tokens';
	if (budget.outputTokens >= limits.outputTokens) return 'output_tokens';
	return null;
}

/**
 * The budget after one more model call; every attempt of a refusal fallback counts. `exhausted`
 * keeps the first limit the turn reached.
 */
export function turnBudget(
	budget: TurnBudget,
	call: { kind: 'chat' | 'draft'; usage: ModelUsage },
	limits: TurnLimits = TURN_LIMITS
): TurnBudget {
	const used = usageTotals(call.usage);
	const next = {
		chatCalls: budget.chatCalls + (call.kind === 'chat' ? 1 : 0),
		drafts: budget.drafts + (call.kind === 'draft' ? 1 : 0),
		inputTokens:
			budget.inputTokens + used.inputTokens + used.cacheReadTokens + used.cacheWriteTokens,
		outputTokens: budget.outputTokens + used.outputTokens
	};
	return Object.freeze({ ...next, exhausted: budget.exhausted ?? turnEndingLimit(next, limits) });
}

/** The limit that stops one more call of this kind, or null when it may be made. */
export function blockingLimit(
	budget: TurnBudget,
	kind: 'chat' | 'draft',
	limits: TurnLimits = TURN_LIMITS
): TurnLimit | null {
	if (budget.exhausted) return budget.exhausted;
	return kind === 'draft' && budget.drafts >= limits.drafts ? 'drafts' : null;
}
