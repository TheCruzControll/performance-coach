import { afterEach, describe, expect, it, vi } from 'vitest';
import { whenNear } from './near-viewport.ts';

/**
 * A stand-in for IntersectionObserver that records its options and target. Like the platform, it
 * delivers no callbacks once disconnected.
 */
class FakeObserver {
	static last: FakeObserver | undefined;

	readonly callback: IntersectionObserverCallback;
	readonly options: IntersectionObserverInit | undefined;
	readonly observed: Element[] = [];
	connected = true;
	disconnects = 0;

	constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
		this.callback = callback;
		this.options = options;
		FakeObserver.last = this;
	}

	observe(target: Element) {
		this.observed.push(target);
	}

	disconnect() {
		this.connected = false;
		this.disconnects++;
	}

	/** The viewport reports the target as intersecting, or not. */
	report(isIntersecting: boolean) {
		if (!this.connected) return;
		const entry = { isIntersecting } as IntersectionObserverEntry;
		this.callback([entry], this as unknown as IntersectionObserver);
	}
}

const target = {} as Element;

afterEach(() => {
	vi.unstubAllGlobals();
	FakeObserver.last = undefined;
});

describe('whenNear without IntersectionObserver', () => {
	it('runs once, at once, and its stop function is harmless', () => {
		const run = vi.fn();
		const stop = whenNear(target, run);
		expect(run).toHaveBeenCalledOnce();
		expect(() => stop()).not.toThrow();
		expect(run).toHaveBeenCalledOnce();
	});
});

describe('whenNear with IntersectionObserver', () => {
	it('observes the target with a rootMargin of one screen above and below', () => {
		vi.stubGlobal('IntersectionObserver', FakeObserver);
		const run = vi.fn();
		whenNear(target, run);
		const observer = FakeObserver.last!;
		expect(observer.options?.rootMargin).toBe('100% 0px');
		expect(observer.observed).toEqual([target]);
		expect(run).not.toHaveBeenCalled();
	});

	it('does not run while nothing intersects', () => {
		vi.stubGlobal('IntersectionObserver', FakeObserver);
		const run = vi.fn();
		whenNear(target, run);
		FakeObserver.last!.report(false);
		expect(run).not.toHaveBeenCalled();
		expect(FakeObserver.last!.disconnects).toBe(0);
	});

	it('runs once when the target intersects, and disconnects', () => {
		vi.stubGlobal('IntersectionObserver', FakeObserver);
		const run = vi.fn();
		whenNear(target, run);
		const observer = FakeObserver.last!;
		observer.report(true);
		expect(run).toHaveBeenCalledOnce();
		expect(observer.disconnects).toBe(1);
		observer.report(true);
		expect(run).toHaveBeenCalledOnce();
	});

	it('the stop function disconnects, and a later intersection does not run', () => {
		vi.stubGlobal('IntersectionObserver', FakeObserver);
		const run = vi.fn();
		const stop = whenNear(target, run);
		const observer = FakeObserver.last!;
		stop();
		expect(observer.disconnects).toBe(1);
		observer.report(true);
		expect(run).not.toHaveBeenCalled();
	});
});
