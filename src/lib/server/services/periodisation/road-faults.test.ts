import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRoadFault, roadFault, roadReleased, setRoadFault } from './road-faults';

afterEach(() => {
	setRoadFault('none', true);
	vi.useRealTimers();
});

describe('the road fault', () => {
	it('is set only where test routes are enabled, and read only there', () => {
		expect(() => setRoadFault('fail', false)).toThrow('only through the test route');
		expect(roadFault(() => true)).toBe('none');
		setRoadFault('fail', true);
		expect(roadFault(() => true)).toBe('fail');
		expect(roadFault(() => false)).toBe('none');
	});

	it('holds a read until it is cleared, or at most its hold', async () => {
		setRoadFault('slow', true);
		let done = false;
		const read = roadReleased().then(() => (done = true));
		await Promise.resolve();
		expect(done).toBe(false);
		setRoadFault('none', true);
		await read;
		expect(done).toBe(true);

		vi.useFakeTimers();
		setRoadFault('slow', true);
		const capped = roadReleased(50);
		vi.advanceTimersByTime(50);
		await expect(capped).resolves.toBeUndefined();
	});

	it('names only its faults', () => {
		expect(['none', 'slow', 'fail', 'hang', 1].map(isRoadFault)).toEqual([
			true,
			true,
			true,
			false,
			false
		]);
	});
});
