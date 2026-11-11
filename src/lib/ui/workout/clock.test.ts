import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClock, msToBoundary } from './clock';

const T0 = 1_000_000;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(T0);
});

afterEach(() => {
	vi.useRealTimers();
});

/** A beat that records the `now` of each of its ticks. */
function beat(anchor: number, lead = false) {
	const ticks: number[] = [];
	return { anchor, lead, ticks, tick: (now: number) => void ticks.push(now) };
}

describe('msToBoundary', () => {
	it('is the time to the next whole second from the anchor, before or after it', () => {
		expect(msToBoundary(T0, T0)).toBe(1_000);
		expect(msToBoundary(T0, T0 + 250)).toBe(750);
		expect(msToBoundary(T0 + 300, T0 + 1_000)).toBe(300);
		expect(msToBoundary(T0 + 120_000, T0 + 900)).toBe(100);
	});
});

describe('the clock', () => {
	it('ticks one timer on its own whole seconds, never drifting', () => {
		const clock = createClock();
		const stopwatch = beat(T0 - 400);
		clock.join(stopwatch);
		vi.advanceTimersByTime(3_000);
		expect(stopwatch.ticks).toEqual([T0 + 600, T0 + 1_600, T0 + 2_600]);
	});

	it('ticks the stopwatch on the same callback as the rest timer, on the rest’s seconds', () => {
		const clock = createClock();
		const stopwatch = beat(T0 - 400);
		const rest = beat(T0 + 120_250, true);
		clock.join(stopwatch);
		clock.join(rest);
		vi.advanceTimersByTime(2_500);
		expect(rest.ticks).toEqual([T0 + 250, T0 + 1_250, T0 + 2_250]);
		expect(stopwatch.ticks).toEqual(rest.ticks);
		// One timer for both: nothing else is due.
		expect(vi.getTimerCount()).toBe(1);
	});

	it('follows the rest whichever joined first, and goes back to the stopwatch’s once it leaves', () => {
		const clock = createClock();
		const rest = beat(T0 + 250, true);
		const leave = clock.join(rest);
		const stopwatch = beat(T0 - 400);
		clock.join(stopwatch);
		vi.advanceTimersByTime(1_000);
		expect(stopwatch.ticks).toEqual([T0 + 250]);
		leave();
		vi.advanceTimersByTime(1_000);
		expect(rest.ticks).toEqual([T0 + 250]);
		expect(stopwatch.ticks).toEqual([T0 + 250, T0 + 1_600]);
	});

	it('stops once the last timer leaves, and a second leave changes nothing', () => {
		const clock = createClock();
		const stopwatch = beat(T0);
		const leave = clock.join(stopwatch);
		leave();
		leave();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(5_000);
		expect(stopwatch.ticks).toEqual([]);
	});
});
