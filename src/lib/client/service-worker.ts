/**
 * Registers the service worker (src/service-worker) once the page has started and gone idle.
 *
 * SvelteKit's own registration (turned off in vite.config.ts) runs on `load`, and here `load`
 * comes before the app has started: it fires once the modulepreloaded chunks have arrived, and
 * the app's code is evaluated and hydrated in the tasks right after it. Registering then starts
 * the worker and its install, which downloads what offline needs into the cache, while the page is
 * still evaluating and hydrating. Hypothesis, not yet confirmed: that install is one cause of the
 * start-up task Lighthouse sometimes saw stretched on CI's runners (about 60 ms to several
 * hundred). Either way the worker is not needed before the app runs, so the root layout calls
 * this on mount, after hydration.
 */

/** Where SvelteKit serves the built service worker (paths.base is empty). */
export const SERVICE_WORKER_URL = '/service-worker.js';
/** The longest the registration waits for an idle period (Chromium, Firefox). */
export const IDLE_TIMEOUT_MS = 3000;
/** Without requestIdleCallback (WebKit): the delay after `load` instead. */
export const FALLBACK_DELAY_MS = 1500;

/** The parts of `window` the registration uses. */
export interface RegistrationHost {
	document: { readyState: DocumentReadyState };
	navigator: { serviceWorker?: Pick<ServiceWorkerContainer, 'register'> };
	addEventListener(type: 'load', listener: () => void, options: { once: true }): void;
	requestIdleCallback?: (callback: () => void, options: { timeout: number }) => unknown;
	setTimeout(callback: () => void, ms: number): unknown;
}

/**
 * Register the service worker after `load`, in the next idle period. A failed registration is
 * left to the unhandled-rejection reporter (src/lib/client/errors.ts), which stays silent while
 * the page is being left, as it did for SvelteKit's registration.
 */
export function registerServiceWorkerWhenIdle(host: RegistrationHost = window): void {
	const container = host.navigator.serviceWorker;
	if (!container) return;
	const register = () => {
		void container.register(SERVICE_WORKER_URL, { type: 'module' });
	};
	const whenIdle = () => {
		if (host.requestIdleCallback) host.requestIdleCallback(register, { timeout: IDLE_TIMEOUT_MS });
		else host.setTimeout(register, FALLBACK_DELAY_MS);
	};
	if (host.document.readyState === 'complete') whenIdle();
	else host.addEventListener('load', whenIdle, { once: true });
}
