/**
 * The service worker registers after `load`, in an idle period, never while the page is still
 * starting: its install downloads the whole build and stretched the app's start-up task on CI.
 */
import { describe, expect, it, vi } from 'vitest';
import {
	FALLBACK_DELAY_MS,
	IDLE_TIMEOUT_MS,
	registerServiceWorkerWhenIdle,
	SERVICE_WORKER_URL,
	type RegistrationHost
} from './service-worker.ts';

/** A window whose `load`, idle callbacks and timers run only when the test says so. */
function fakeHost(options: { readyState: DocumentReadyState; idle?: boolean; worker?: boolean }) {
	const register = vi.fn(() => Promise.resolve({} as ServiceWorkerRegistration));
	const load: (() => void)[] = [];
	const idle: { callback: () => void; timeout: number }[] = [];
	const timers: { callback: () => void; ms: number }[] = [];
	const host: RegistrationHost = {
		document: { readyState: options.readyState },
		navigator: options.worker === false ? {} : { serviceWorker: { register } },
		addEventListener: (_type, listener) => void load.push(listener),
		setTimeout: (callback, ms) => timers.push({ callback, ms }),
		...(options.idle === false
			? {}
			: {
					requestIdleCallback: (callback: () => void, { timeout }: { timeout: number }) =>
						idle.push({ callback, timeout })
				})
	};
	const fire = (queue: { callback: () => void }[] | (() => void)[]) => {
		for (const item of queue.splice(0)) (typeof item === 'function' ? item : item.callback)();
	};
	return { host, register, load, idle, timers, fire };
}

describe('registerServiceWorkerWhenIdle', () => {
	it('waits for load, then for an idle period, before registering', () => {
		const page = fakeHost({ readyState: 'interactive' });
		registerServiceWorkerWhenIdle(page.host);
		expect(page.register).not.toHaveBeenCalled();
		expect(page.idle).toHaveLength(0);

		page.fire(page.load);
		expect(page.register).not.toHaveBeenCalled();
		expect(page.idle.map((i) => i.timeout)).toEqual([IDLE_TIMEOUT_MS]);

		page.fire(page.idle);
		expect(page.register).toHaveBeenCalledOnce();
		expect(page.register).toHaveBeenCalledWith(SERVICE_WORKER_URL, { type: 'module' });
	});

	it('after load (the usual case on mount) still waits for an idle period', () => {
		const page = fakeHost({ readyState: 'complete' });
		registerServiceWorkerWhenIdle(page.host);
		expect(page.load).toHaveLength(0);
		expect(page.register).not.toHaveBeenCalled();

		page.fire(page.idle);
		expect(page.register).toHaveBeenCalledOnce();
	});

	it('without requestIdleCallback (WebKit), registers a fixed delay after load', () => {
		const page = fakeHost({ readyState: 'loading', idle: false });
		registerServiceWorkerWhenIdle(page.host);
		page.fire(page.load);
		expect(page.register).not.toHaveBeenCalled();
		expect(page.timers.map((t) => t.ms)).toEqual([FALLBACK_DELAY_MS]);

		page.fire(page.timers);
		expect(page.register).toHaveBeenCalledWith(SERVICE_WORKER_URL, { type: 'module' });
	});

	it('does nothing where there are no service workers', () => {
		const page = fakeHost({ readyState: 'complete', worker: false });
		registerServiceWorkerWhenIdle(page.host);
		expect(page.idle).toHaveLength(0);
		expect(page.timers).toHaveLength(0);
	});
});
