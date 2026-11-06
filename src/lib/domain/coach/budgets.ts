/**
 * PLACEHOLDER, replaced only by coach-tool-catalogue (m5/02): every limit on a coach turn, derived
 * from one duration constant, plus the daily cap and when a segment is summarised. The names and
 * types below are the contract that slice keeps. Until it lands the limits are zero, so anything
 * that read them would stop before its first call, and the functions throw.
 */
import type { TokenUsage } from './pricing.ts';
import type { ToolCatalogueEntry } from './tools.ts';

/** The turn endpoint's maxDuration on Vercel; every time limit below derives from it. */
export const COACH_MAX_DURATION_S = 180;

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

export const TURN_LIMITS: TurnLimits = {
	turnMs: 0,
	draftMs: 0,
	toolMs: 0,
	staleRunMs: 0,
	chatCalls: 0,
	drafts: 0,
	maxTokens: { chat: 0, draft: 0, summary: 0 },
	outputTokens: 0,
	inputTokens: 0,
	concurrency: 0,
	toolOutputBytes: 0
};
export const DAILY_LIMITS: DailyLimits = { costMicros: 0 };
export const SEGMENT: SegmentLimits = { inputTokens: 0, messages: 0 };

export type TurnLimit = 'chat_calls' | 'drafts' | 'input_tokens' | 'output_tokens';

export interface TurnBudget {
	chatCalls: number;
	drafts: number;
	inputTokens: number;
	outputTokens: number;
	/** The first limit the turn reached, or null while it may make another call. */
	exhausted: TurnLimit | null;
}

const placeholder = (name: string): never => {
	throw new Error(`${name} arrives with the turn limits (coach-tool-catalogue)`);
};

/** How long a tool may run: a drafting tool gets its draft's time too, never past the turn. */
export function toolDeadlineMs(
	_entry: Pick<ToolCatalogueEntry, 'drafts'>,
	_remainingMs: number
): number {
	return placeholder('toolDeadlineMs');
}

/** The budget after one more model call. */
export function turnBudget(
	_budget: TurnBudget,
	_call: { kind: 'chat' | 'draft'; usage: TokenUsage }
): TurnBudget {
	return placeholder('turnBudget');
}
