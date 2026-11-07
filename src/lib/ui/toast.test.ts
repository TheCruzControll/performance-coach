import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from './toast.svelte.ts';

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	for (const item of toast.items) toast.dismiss(item.id);
	vi.useRealTimers();
});

const ids = () => toast.items.map((item) => item.id);

describe('toast', () => {
	it('waits until a toast appears before its time on screen starts', () => {
		const id = toast.show('Set logged');
		vi.advanceTimersByTime(10_000);
		expect(ids()).toEqual([id]);

		toast.appeared(id);
		vi.advanceTimersByTime(3_999);
		expect(ids()).toEqual([id]);
		vi.advanceTimersByTime(1);
		expect(ids()).toEqual([]);
	});

	it('drops a timed toast that never appears', () => {
		const id = toast.show('Set logged');
		vi.advanceTimersByTime(59_999);
		expect(ids()).toEqual([id]);
		vi.advanceTimersByTime(1);
		expect(ids()).toEqual([]);
	});
});
