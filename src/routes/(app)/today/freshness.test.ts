import { describe, expect, it } from 'vitest';
import { isStale, TODAY_TTL_MS } from './freshness';

const MINUTE = 60_000;

describe("isStale (Today's data on return to the foreground)", () => {
	const loaded = new Date(2026, 10, 11, 9, 0);

	it('is fresh within the TTL on the same day', () => {
		expect(isStale(loaded, loaded)).toBe(false);
		expect(isStale(loaded, new Date(loaded.getTime() + TODAY_TTL_MS - MINUTE))).toBe(false);
	});

	it('is stale once the TTL has passed', () => {
		expect(TODAY_TTL_MS).toBe(30 * MINUTE);
		expect(isStale(loaded, new Date(loaded.getTime() + TODAY_TTL_MS))).toBe(true);
		expect(isStale(loaded, new Date(loaded.getTime() + 5 * MINUTE), 5 * MINUTE)).toBe(true);
	});

	it('is stale on another day by the device clock, however little time passed', () => {
		const lateNight = new Date(2026, 10, 11, 23, 59);
		expect(isStale(lateNight, new Date(2026, 10, 12, 0, 1))).toBe(true);
		// The clock set back across midnight
		expect(isStale(new Date(2026, 10, 12, 0, 1), lateNight)).toBe(true);
	});

	it('is fresh when the clock moved back within the same day', () => {
		expect(isStale(loaded, new Date(2026, 10, 11, 8, 50))).toBe(false);
	});
});
