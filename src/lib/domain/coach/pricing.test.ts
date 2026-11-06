import { describe, expect, it } from 'vitest';
import {
	capCostMicros,
	costMicros,
	formatCost,
	PRICING,
	usageTotals,
	type ModelUsage,
	type TokenUsage
} from './pricing';

const OPUS_5_5 = 'claude-opus-5-5';
const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0): TokenUsage => ({
	inputTokens: input,
	outputTokens: output,
	cacheReadTokens: cacheRead,
	cacheWriteTokens: cacheWrite
});
const TYPICAL = usage(1_000, 500, 20_000, 3_000);

describe('the price table', () => {
	it('prices the coach model and both fallback targets per million tokens', () => {
		expect(PRICING).toEqual({
			'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5 },
			'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25 },
			'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25 }
		});
		expect(Object.isFrozen(PRICING)).toBe(true);
		for (const price of Object.values(PRICING)) expect(Object.isFrozen(price)).toBe(true);
	});

	it('holds every rate as a whole number of tenths of a cent, so costs add up exactly', () => {
		for (const price of Object.values(PRICING))
			for (const rate of Object.values(price)) {
				expect(rate).toBeGreaterThan(0);
				expect(Math.abs(rate * 1000 - Math.round(rate * 1000))).toBeLessThan(1e-6);
			}
	});
});

describe('costMicros', () => {
	it('prices each token type at its own rate, in exact micro-dollars', () => {
		// 1,000 × $4 + 500 × $20 + 20,000 × $0.20 + 3,000 × $5, per million tokens.
		expect(costMicros(TYPICAL, OPUS_5_5)).toBe(4_000 + 10_000 + 4_000 + 15_000);
		expect(costMicros(TYPICAL, 'claude-opus-5')).toBe(5_000 + 12_500 + 10_000 + 18_750);
		expect(costMicros(usage(1_000_000, 0), OPUS_5_5)).toBe(4_000_000);
		expect(costMicros(usage(0, 1_000_000), OPUS_5_5)).toBe(20_000_000);
		expect(costMicros(usage(0, 0, 1_000_000), OPUS_5_5)).toBe(200_000);
		expect(costMicros(usage(0, 0, 0, 1_000_000), OPUS_5_5)).toBe(5_000_000);
		expect(costMicros(usage(0, 0), OPUS_5_5)).toBe(0);
	});

	it('adds fractions of a micro-dollar exactly and rounds the call once, half up', () => {
		// 1 + 14 cache reads at $0.20 are exactly 3 micro-dollars; added as floats they are
		// 3.0000000000000004, which a cap rounding up would count as 4.
		const split: ModelUsage = {
			...usage(0, 0, 14),
			iterations: [
				{ kind: 'message', model: OPUS_5_5, ...usage(0, 0, 1) },
				{ kind: 'fallback_message', model: OPUS_5_5, ...usage(0, 0, 14) }
			]
		};
		expect(costMicros(split, OPUS_5_5)).toBe(3);
		expect(capCostMicros(split, OPUS_5_5)).toBe(3);
		expect(costMicros(usage(0, 0, 35), OPUS_5_5)).toBe(7);
		expect(costMicros(usage(0, 0, 2), OPUS_5_5)).toBe(0); // 0.4
		expect(costMicros(usage(0, 0, 3), OPUS_5_5)).toBe(1); // 0.6
		expect(costMicros(usage(0, 0, 1, 0), 'claude-opus-5')).toBe(1); // 0.5
		expect(costMicros(usage(0, 0, 2, 0), 'claude-opus-4-8')).toBe(1); // 1.0
		// 0.5 + 12.5 is 13: rounded once for the call, not once per token type (1 + 13).
		expect(costMicros(usage(0, 0, 1, 2), 'claude-opus-5')).toBe(13);
		expect(capCostMicros(usage(0, 0, 1, 2), 'claude-opus-5')).toBe(13);
	});

	it('prices each attempt of a fallback at the model that ran it, ignoring the top-level copy', () => {
		const declined = usage(12_000, 40, 0, 6_000);
		const served = usage(12_000, 900, 0, 6_000);
		const call: ModelUsage = {
			...served,
			iterations: [
				{ kind: 'message', model: OPUS_5_5, ...declined },
				{ kind: 'fallback_message', model: 'claude-opus-4-8', ...served }
			]
		};
		const expected =
			(costMicros(declined, OPUS_5_5) ?? NaN) + (costMicros(served, 'claude-opus-4-8') ?? NaN);
		expect(expected).toBe(48_000 + 800 + 30_000 + (60_000 + 22_500 + 37_500));
		expect(costMicros(call, OPUS_5_5)).toBe(expected);
		// The model argument names the requested model; with iterations it is not what is priced.
		expect(costMicros(call, 'claude-opus-5')).toBe(expected);
		expect(capCostMicros(call, OPUS_5_5)).toBe(expected);
		// No iterations (or an empty list): the call is one attempt at the requested model.
		expect(costMicros({ ...served, iterations: [] }, OPUS_5_5)).toBe(costMicros(served, OPUS_5_5));
	});

	it('is null when a model that ran is not in the table', () => {
		expect(costMicros(TYPICAL, 'claude-opus-9')).toBeNull();
		for (const name of ['toString', '__proto__', 'constructor', 'hasOwnProperty', ''])
			expect(costMicros(TYPICAL, name)).toBeNull();
		const call: ModelUsage = {
			...TYPICAL,
			iterations: [
				{ kind: 'message', model: OPUS_5_5, ...TYPICAL },
				{ kind: 'fallback_message', model: 'claude-opus-9', ...TYPICAL }
			]
		};
		expect(costMicros(call, OPUS_5_5)).toBeNull();
	});

	it('refuses token counts that are not whole and non-negative', () => {
		for (const bad of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => costMicros(usage(bad, 0), OPUS_5_5)).toThrow(RangeError);
			expect(() => capCostMicros(usage(0, 0, 0, bad), 'claude-opus-9')).toThrow(RangeError);
		}
	});
});

describe('capCostMicros', () => {
	it('prices an unknown model at the highest known rate of each token type', () => {
		const highest = 5_000 + 12_500 + 10_000 + 18_750;
		expect(capCostMicros(TYPICAL, 'claude-opus-9')).toBe(highest);
		expect(capCostMicros(TYPICAL, 'toString')).toBe(highest);
		for (const model of Object.keys(PRICING))
			expect(capCostMicros(TYPICAL, 'claude-opus-9')).toBeGreaterThanOrEqual(
				costMicros(TYPICAL, model) ?? Infinity
			);
		// A cheap model's rates never lower the cap: each type takes its own maximum.
		const cacheHeavy = usage(0, 0, 1_000_000);
		expect(capCostMicros(cacheHeavy, 'claude-opus-9')).toBe(500_000);
		expect(capCostMicros(cacheHeavy, 'claude-opus-9')).toBeGreaterThan(
			costMicros(cacheHeavy, OPUS_5_5) ?? Infinity
		);
	});

	it('prices a known model at its own rates, and an unknown attempt at the highest', () => {
		expect(capCostMicros(TYPICAL, OPUS_5_5)).toBe(costMicros(TYPICAL, OPUS_5_5));
		const call: ModelUsage = {
			...TYPICAL,
			iterations: [
				{ kind: 'message', model: OPUS_5_5, ...TYPICAL },
				{ kind: 'fallback_message', model: 'claude-opus-9', ...TYPICAL }
			]
		};
		expect(capCostMicros(call, OPUS_5_5)).toBe(33_000 + 46_250);
	});

	it('never counts less than the call costs, rounding a fraction up', () => {
		expect(capCostMicros(usage(0, 0, 2), OPUS_5_5)).toBe(1); // 0.4
		expect(capCostMicros(usage(0, 0, 35), OPUS_5_5)).toBe(7);
		const usages = [TYPICAL, usage(1, 1, 1, 1), usage(7, 3, 11, 13), usage(123_457, 9_871, 3, 0)];
		for (const each of usages)
			for (const model of [...Object.keys(PRICING), 'claude-opus-9']) {
				const cap = capCostMicros(each, model);
				expect(Number.isInteger(cap)).toBe(true);
				for (const known of Object.keys(PRICING))
					if (known === model || !Object.hasOwn(PRICING, model))
						expect(cap).toBeGreaterThanOrEqual(costMicros(each, known) ?? Infinity);
			}
	});
});

describe('usageTotals', () => {
	it('sums every attempt when there are iterations, and is the call itself otherwise', () => {
		expect(usageTotals(TYPICAL)).toEqual(TYPICAL);
		const call: ModelUsage = {
			...usage(5, 6, 7, 8),
			iterations: [
				{ kind: 'message', model: OPUS_5_5, ...usage(1, 2, 3, 4) },
				{ kind: 'fallback_message', model: 'claude-opus-5', ...usage(5, 6, 7, 8) }
			]
		};
		expect(usageTotals(call)).toEqual(usage(6, 8, 10, 12));
	});
});

describe('formatCost', () => {
	it('shows dollars and cents, with less than a cent as such', () => {
		expect(formatCost(0)).toBe('$0.00');
		expect(formatCost(1)).toBe('<$0.01');
		expect(formatCost(4_999)).toBe('<$0.01');
		expect(formatCost(5_000)).toBe('$0.01');
		expect(formatCost(33_000)).toBe('$0.03');
		expect(formatCost(1_234_567)).toBe('$1.23');
		expect(formatCost(1_235_000)).toBe('$1.24');
		expect(formatCost(5_000_000)).toBe('$5.00');
		expect(formatCost(1_234_567_890)).toBe('$1,234.57');
	});

	it('refuses a negative or fractional amount', () => {
		for (const bad of [-1, 0.5, Number.NaN]) expect(() => formatCost(bad)).toThrow(RangeError);
	});
});
