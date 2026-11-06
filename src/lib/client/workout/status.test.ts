import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OutboxStatus } from './outbox-rules';
import { outboxStatus, RETRY_TICK_MS } from './status.svelte.ts';

/** An engine as the wrapper sees it: a status, and a change event. */
function fakeEngine(first: OutboxStatus | null) {
	let status = first;
	const listeners = new Set<() => void>();
	return {
		status: vi.fn(() => status),
		onChange(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set(next: OutboxStatus) {
			status = next;
			listeners.forEach((l) => l());
		},
		get listening() {
			return listeners.size;
		}
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe('the reactive sync status', () => {
	it('mirrors the engine, reads a retry countdown each second, and stops when asked', () => {
		vi.useFakeTimers();
		const engine = fakeEngine(null);
		const stop = outboxStatus.follow(engine);
		expect(outboxStatus.current).toBeNull();

		engine.set({ state: 'offline', pending: 2 });
		expect(outboxStatus.current).toEqual({ state: 'offline', pending: 2 });
		vi.advanceTimersByTime(10 * RETRY_TICK_MS);
		expect(engine.status).toHaveBeenCalledTimes(2); // no countdown to keep current

		engine.set({ state: 'retrying', seconds: 3, pending: 2 });
		expect(engine.status).toHaveBeenCalledTimes(3);
		vi.advanceTimersByTime(RETRY_TICK_MS);
		expect(engine.status).toHaveBeenCalledTimes(4);

		engine.set({ state: 'synced' });
		vi.advanceTimersByTime(10 * RETRY_TICK_MS);
		expect(engine.status).toHaveBeenCalledTimes(5);
		expect(outboxStatus.current).toEqual({ state: 'synced' });

		engine.set({ state: 'retrying', seconds: 9, pending: 1 });
		stop();
		expect(engine.listening).toBe(0);
		vi.advanceTimersByTime(10 * RETRY_TICK_MS);
		expect(engine.status).toHaveBeenCalledTimes(6);
	});
});
