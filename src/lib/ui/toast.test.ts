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

	it('shows one at a time: a new toast takes the place of the one on screen', () => {
		const first = toast.show('Set logged');
		toast.appeared(first);
		const second = toast.show('Upper body moved to Saturday', {
			action: { label: 'Undo', onclick: () => {} }
		});
		expect(ids()).toEqual([second]);
		// The first one's timer is gone with it: it cannot dismiss the second.
		vi.advanceTimersByTime(4_000);
		expect(ids()).toEqual([second]);
	});

	it('keeps a toast with no duration until it is dismissed or replaced', () => {
		const sticky = toast.show('Couldn’t load this part of the coach', {
			tone: 'danger',
			duration: 0
		});
		toast.appeared(sticky);
		vi.advanceTimersByTime(120_000);
		expect(ids()).toEqual([sticky]);
		const next = toast.show('Saved', { tone: 'positive' });
		expect(ids()).toEqual([next]);
	});
});
