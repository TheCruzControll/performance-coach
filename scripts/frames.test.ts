/** e2e/frames.ts: perf-workout.e2e.ts's dropped-frame gate, from animation frame timestamps. */
import { describe, expect, it } from 'vitest';
import { longFrames } from '../e2e/frames.ts';

describe('longFrames', () => {
	it('finds the gaps between frames longer than the limit, each at its end', () => {
		// 60 Hz with one frame dropped (33.4 ms) and one long one (50 ms).
		const times = [0, 16.7, 33.4, 66.8, 83.5, 133.5, 150.2];
		expect(longFrames(times, [], 32)).toEqual([
			{ at: 66.8, ms: 33.4 },
			{ at: 133.5, ms: 50 }
		]);
	});

	it('leaves out a frame an input was answered in: INP gates those', () => {
		const times = [0, 16.7, 72.7, 89.4, 139.4];
		// A tap at 20 painted 56 ms later: the 16.7 → 72.7 frame is its own.
		expect(longFrames(times, [[20, 76]], 32)).toEqual([{ at: 139.4, ms: 50 }]);
		// A window that only touches the frame's start or end leaves it in.
		expect(longFrames(times, [[0, 16.7]], 32)).toHaveLength(2);
		expect(longFrames(times, [[72.7, 80]], 32)).toHaveLength(2);
	});

	it('reports nothing for steady frames, one frame or none', () => {
		expect(longFrames([0, 16.7, 33.3, 50, 66.7], [], 32)).toEqual([]);
		expect(longFrames([10], [], 32)).toEqual([]);
		expect(longFrames([], [], 32)).toEqual([]);
	});
});
