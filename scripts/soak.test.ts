/** e2e/soak.ts: perf-soak.e2e.ts's heap growth and late-workout INP over one long session. */
import { describe, expect, it } from 'vitest';
import { heapGrowth, lateInp, type HeapSample } from '../e2e/soak.ts';

const sample = (sets: number, heapBytes: number): HeapSample => ({
	sets,
	heapBytes,
	nodes: 1_000,
	listeners: 100
});

describe('heapGrowth', () => {
	it('measures from the first sample after the warm-up, not the cold start, to the last', () => {
		// The first sets load the sheet's, Up next's and the rest timer's chunks: 4 MB → 8 MB is warm-up.
		const samples = [
			sample(0, 4_000_000),
			sample(10, 8_000_000),
			sample(25, 8_200_000),
			sample(40, 8_400_000)
		];
		const { warm, last, growth } = heapGrowth(samples, 10);
		expect(warm.sets).toBe(10);
		expect(last.sets).toBe(40);
		expect(growth).toBeCloseTo(0.05, 10);
	});

	it('takes the first sample at or past the warm-up when none falls on it', () => {
		const { warm, growth } = heapGrowth(
			[sample(8, 5_000_000), sample(12, 6_000_000), sample(40, 6_600_000)],
			10
		);
		expect(warm.sets).toBe(12);
		expect(growth).toBeCloseTo(0.1, 10);
	});

	it('reads a heap that shrank as negative growth', () => {
		expect(heapGrowth([sample(10, 8_000_000), sample(40, 7_600_000)], 10).growth).toBeCloseTo(
			-0.05,
			10
		);
	});

	it('refuses to compare without a later sample than the warm one', () => {
		expect(() => heapGrowth([sample(4, 1), sample(8, 2)], 10)).toThrow(/after the 10-set warm-up/);
		expect(() => heapGrowth([sample(10, 1)], 10)).toThrow(/after the 10-set warm-up/);
	});
});

describe('lateInp', () => {
	it('reads only the interactions from set `from` on, and the slowest of them', () => {
		// A 400 ms tap early in the workout is not the late session's.
		const entries = [
			{ id: 1, duration: 400, set: 3 },
			{ id: 2, duration: 120, set: 30 },
			{ id: 3, duration: 64, set: 35 },
			{ id: 3, duration: 72, set: 35 }
		];
		expect(lateInp(entries, 30, 20)).toEqual({ inp: 120, slowest: 120, interactions: 2 });
	});

	it("skips the longest once 50 late taps happened, counting the observer's unreported fast ones", () => {
		const entries = [
			{ id: 7, duration: 260, set: 31 },
			{ id: 8, duration: 90, set: 39 }
		];
		expect(lateInp(entries, 30, 60)).toEqual({ inp: 90, slowest: 260, interactions: 2 });
		expect(lateInp(entries, 30, 49).inp).toBe(260);
	});

	it('reads 0 when no late interaction was slow enough to be reported', () => {
		expect(lateInp([{ id: 1, duration: 80, set: 2 }], 30, 40)).toEqual({
			inp: 0,
			slowest: 0,
			interactions: 0
		});
	});
});
