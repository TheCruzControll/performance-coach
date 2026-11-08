/** e2e/inp.ts: perf-workout.e2e.ts's INP estimate counts the interactions its observer omits. */
import { describe, expect, it } from 'vitest';
import { inp } from '../e2e/inp.ts';

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
