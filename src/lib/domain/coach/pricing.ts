/**
 * PLACEHOLDER, replaced only by coach-tool-catalogue (m5/02): what a model call costs, in
 * micro-dollars, so every run, the daily cap and diagnostics price calls one way. The names and
 * types below are the contract that slice keeps. Until it lands no price is known, and the
 * functions throw rather than report a cost of zero that the daily cap would trust.
 */

/** US dollars per million tokens. The coach only writes the 5-minute cache. */
export interface ModelPrice {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite5m: number;
}

/** One call's tokens, as the agent stores them (mapped from the API's `usage`). */
export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

/**
 * One attempt inside a call. With server-side refusal fallbacks, `usage.iterations` lists each
 * attempt: a declined one as 'message', the one a fallback model served as 'fallback_message',
 * each billed at its own model's rates. `model` is the model that ran it.
 */
export interface UsageIteration extends TokenUsage {
	kind: 'message' | 'fallback_message';
	model: string;
}

/** A call's usage; when `iterations` is present it is the per-model source of truth. */
export interface ModelUsage extends TokenUsage {
	iterations?: readonly UsageIteration[];
}

/** Prices by exact model id. */
export const PRICING: Readonly<Record<string, ModelPrice>> = {};

const placeholder = (name: string): never => {
	throw new Error(`${name} arrives with the pricing table (coach-tool-catalogue)`);
};

/** The call's cost; null when a model that ran is not in PRICING. */
export function costMicros(_usage: ModelUsage, _model: string): number | null {
	return placeholder('costMicros');
}

/** The cost the daily cap counts: an unknown model is priced at the highest known rate. */
export function capCostMicros(_usage: ModelUsage, _model: string): number {
	return placeholder('capCostMicros');
}

/** Micro-dollars as the screen shows them. */
export function formatCost(_micros: number): string {
	return placeholder('formatCost');
}
