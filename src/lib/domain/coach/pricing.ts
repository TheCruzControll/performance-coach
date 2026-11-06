/**
 * What a model call costs, in micro-dollars, so every run, the daily cap and diagnostics price
 * calls one way. This is the only place prices live: they are the Claude API's first-party rates
 * per million tokens, from the claude-api skill's model table cached on 2026-10-06.
 *
 * A model's price per million tokens is also its price in micro-dollars per token, so a call costs
 * tokens × rate micro-dollars. Rates are held in thousandths of a dollar, which makes every sum
 * exact; a call is rounded once, at the end.
 *
 * Two prices per call. costMicros is what diagnostics show, and it is null when a model that ran is
 * not in the table, rather than a guess. capCostMicros is what the daily cap counts: it never
 * under-counts, so it prices an unknown model at the highest known rate of each token type and
 * rounds a fraction of a micro-dollar up.
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

const price = (input: number, output: number, cacheRead: number, cacheWrite5m: number) =>
	Object.freeze({ input, output, cacheRead, cacheWrite5m });

/**
 * Prices by exact model id: the coach's model, and the targets its refusal fallbacks can route to
 * (Claude Opus 5 and Claude Opus 4.8). Cache reads are 0.05× input on Opus 5.5 and 0.1× on the
 * others; 5-minute cache writes are 1.25× input.
 */
export const PRICING: Readonly<Record<string, Readonly<ModelPrice>>> = Object.freeze({
	'claude-opus-5-5': price(4, 20, 0.2, 5),
	'claude-opus-5': price(5, 25, 0.5, 6.25),
	'claude-opus-4-8': price(5, 25, 0.5, 6.25)
});

/** Every rate is a whole number of tenths of a cent (pricing.test.ts checks), so sums are exact. */
const RATE_SCALE = 1000;

const TOKEN_TYPES = [
	['inputTokens', 'input'],
	['outputTokens', 'output'],
	['cacheReadTokens', 'cacheRead'],
	['cacheWriteTokens', 'cacheWrite5m']
] as const;

const highest = (rate: keyof ModelPrice) =>
	Math.max(...Object.values(PRICING).map((each) => each[rate]));
/** The highest known rate of each token type: what an unknown model is capped at. */
const HIGHEST = price(
	highest('input'),
	highest('output'),
	highest('cacheRead'),
	highest('cacheWrite5m')
);

function priceOf(model: string): Readonly<ModelPrice> | undefined {
	return Object.hasOwn(PRICING, model) ? PRICING[model] : undefined;
}

/** Each attempt with the model that ran it: the iterations, or the call itself at `model`. */
function attempts(usage: ModelUsage, model: string): readonly (TokenUsage & { model: string })[] {
	return usage.iterations?.length ? usage.iterations : [{ ...usage, model }];
}

/** One attempt's cost in thousandths of a micro-dollar: an exact integer. */
function thousandths(tokens: TokenUsage, rates: ModelPrice): number {
	let sum = 0;
	for (const [count, rate] of TOKEN_TYPES) {
		const n = tokens[count];
		if (!Number.isInteger(n) || n < 0) throw new RangeError(`${count} must be a whole number ≥ 0`);
		sum += n * Math.round(rates[rate] * RATE_SCALE);
	}
	return sum;
}

/** Thousandths to whole micro-dollars, without a float division. */
function toMicros(sum: number, up: boolean): number {
	const rest = sum % RATE_SCALE;
	const whole = (sum - rest) / RATE_SCALE;
	return (up ? rest > 0 : rest >= RATE_SCALE / 2) ? whole + 1 : whole;
}

/** The call's cost; null when a model that ran is not in PRICING. */
export function costMicros(usage: ModelUsage, model: string): number | null {
	let sum = 0;
	for (const attempt of attempts(usage, model)) {
		const rates = priceOf(attempt.model);
		if (!rates) return null;
		sum += thousandths(attempt, rates);
	}
	return toMicros(sum, false);
}

/** The cost the daily cap counts: an unknown model is priced at the highest known rate. */
export function capCostMicros(usage: ModelUsage, model: string): number {
	let sum = 0;
	for (const attempt of attempts(usage, model))
		sum += thousandths(attempt, priceOf(attempt.model) ?? HIGHEST);
	return toMicros(sum, true);
}

/** Every token the call used, all attempts included: what the turn's budget counts. */
export function usageTotals(usage: ModelUsage): TokenUsage {
	const totals: TokenUsage = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0
	};
	for (const attempt of usage.iterations?.length ? usage.iterations : [usage])
		for (const [count] of TOKEN_TYPES) totals[count] += attempt[count];
	return totals;
}

/** Micro-dollars as the screen shows them: '$1.23', '$0.00', and '<$0.01' for less than a cent. */
export function formatCost(micros: number): string {
	if (!Number.isInteger(micros) || micros < 0)
		throw new RangeError('A cost is a whole number of micro-dollars ≥ 0');
	const rest = micros % 10_000;
	const cents = (micros - rest) / 10_000 + (rest >= 5_000 ? 1 : 0);
	if (cents === 0 && micros > 0) return '<$0.01';
	const dollars = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	return `$${dollars}.${String(cents % 100).padStart(2, '0')}`;
}
