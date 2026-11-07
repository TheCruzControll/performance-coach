import { describe, expect, it, vi } from 'vitest';
import { chunkLoader } from './lazy.ts';

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
