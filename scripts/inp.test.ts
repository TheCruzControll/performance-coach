/** e2e/inp.ts: perf-workout.e2e.ts's INP estimate counts the interactions its observer omits. */
import { describe, expect, it } from 'vitest';
import { attribute, inp, percentile } from '../e2e/inp.ts';

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

describe('attribute', () => {
	type Kind = 'sheet' | 'start' | 'swipe' | 'stepper' | 'other';
	it("names an interaction by its pointerdown's tag when its target has left the page", () => {
		// The sheet's Close: by the time Event Timing reports, the button is gone (target null).
		const entries = [
			{ id: 7, duration: 56, startTime: 1_003, kind: 'other' as Kind },
			{ id: 7, duration: 48, startTime: 1_000, kind: 'other' as Kind }
		];
		const tags = [
			{ at: 400, kind: 'stepper' as Kind },
			{ at: 1_000, kind: 'sheet' as Kind }
		];
		expect(attribute(entries, tags, 'other').get(7)).toBe('sheet');
	});

	it('takes the last pointerdown at or before the interaction, not a later or stale one', () => {
		const entries = [
			{ id: 1, duration: 24, startTime: 500, kind: 'other' as Kind },
			{ id: 2, duration: 24, startTime: 5_000, kind: 'other' as Kind }
		];
		const tags = [
			{ at: 100, kind: 'stepper' as Kind },
			{ at: 480, kind: 'start' as Kind },
			{ at: 520, kind: 'swipe' as Kind }
		];
		const kinds = attribute(entries, tags, 'other');
		expect(kinds.get(1)).toBe('start');
		// 4.5 s after the last pointerdown: a keyboard interaction, not that tap.
		expect(kinds.get(2)).toBe('other');
	});

	it("falls back to the entries' own targets, the first that names a kind", () => {
		const entries = [
			{ id: 3, duration: 16, startTime: 900, kind: 'other' as Kind },
			{ id: 3, duration: 24, startTime: 901, kind: 'stepper' as Kind }
		];
		expect(attribute(entries, [], 'other').get(3)).toBe('stepper');
		expect(attribute(entries.slice(0, 1), [], 'other').get(3)).toBe('other');
	});
});
