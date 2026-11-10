import { afterEach, describe, expect, it, vi } from 'vitest';
import { AFTER_PAINT_FALLBACK_MS, afterPaint, chunkLoader } from './lazy.ts';

describe('chunkLoader', () => {
	it('answers the loaded chunk and reports nothing', async () => {
		const onStale = vi.fn();
		const load = chunkLoader(onStale);
		await expect(load(async () => ({ default: 'sheet' }))).resolves.toEqual({ default: 'sheet' });
		expect(onStale).not.toHaveBeenCalled();
	});

	it('reports a chunk that failed to load as stale, and answers null', async () => {
		const onStale = vi.fn();
		const load = chunkLoader(onStale);
		const gone = new TypeError('Failed to fetch dynamically imported module');
		await expect(load(() => Promise.reject(gone))).resolves.toBeNull();
		expect(onStale).toHaveBeenCalledExactlyOnceWith(gone);
	});
});

describe('afterPaint', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	/** A page whose frames are run by hand: `paint()` runs the frame requested. */
	function frames() {
		vi.useFakeTimers();
		const requested: FrameRequestCallback[] = [];
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
			requested.push(callback);
			return requested.length;
		});
		return { paint: () => requested.splice(0).forEach((callback) => callback(0)) };
	}

	it('runs once the frame being rendered is on screen, not before, and only once', () => {
		const { paint } = frames();
		const run = vi.fn();
		afterPaint(run);
		vi.advanceTimersByTime(0);
		expect(run).not.toHaveBeenCalled();
		paint();
		vi.advanceTimersByTime(0);
		expect(run).not.toHaveBeenCalled();
		paint();
		expect(run).not.toHaveBeenCalled();
		vi.advanceTimersByTime(0);
		expect(run).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(AFTER_PAINT_FALLBACK_MS);
		expect(run).toHaveBeenCalledOnce();
	});

	it('runs anyway on a page that paints no frame (hidden)', () => {
		frames();
		const run = vi.fn();
		afterPaint(run);
		vi.advanceTimersByTime(AFTER_PAINT_FALLBACK_MS - 1);
		expect(run).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(run).toHaveBeenCalledOnce();
	});
});
