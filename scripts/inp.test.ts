/** e2e/inp.ts: perf-workout.e2e.ts's INP estimate counts the interactions its observer omits. */
import { describe, expect, it } from 'vitest';
import { inp, percentile } from '../e2e/inp.ts';

describe('inp', () => {
	it('skips the longest once 50 interactions happened, fast unreported ones included', () => {
		// 82 taps: 240 ms and 64 ms reported, eighty 8 ms ones under the observer's threshold.
		const reported = [
			{ id: 1, duration: 240 },
			{ id: 2, duration: 64 }
		];
		expect(inp(reported, 82)).toBe(64);
		expect(inp(reported, 49)).toBe(240);
	});
});

describe('percentile', () => {
	it("reads p75 over five loads as the fourth fastest, CrUX's nearest rank", () => {
		expect(percentile([90, 40, 200, 64, 120], 0.75)).toBe(120);
		expect(percentile([300, 10, 20, 30], 0.75)).toBe(30);
		expect(percentile([56], 0.75)).toBe(56);
		expect(percentile([], 0.75)).toBeNaN();
	});

	it('takes the median of an even count as the lower middle and p95 of 20 as the 19th', () => {
		const twenty = Array.from({ length: 20 }, (_, i) => 20 - i);
		expect(percentile(twenty, 0.5)).toBe(10);
		expect(percentile(twenty, 0.95)).toBe(19);
	});
});
