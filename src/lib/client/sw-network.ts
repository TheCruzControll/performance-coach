/**
 * The service worker's network answers for server data (src/service-worker/index.ts), kept free of
 * `$app/*` so they run in unit tests.
 *
 * - A server-rendered navigation takes the browser's navigation preload when there is one: the
 *   request starts while the worker boots instead of after it (fromNetwork).
 * - A client-side data load (SvelteKit's `__data.json` GET) gets a bounded wait (loadData). A
 *   connected-but-dead network ("lie-fi") can hang it for a minute or more; past the wait, or when
 *   the request fails, the worker answers 503 with the offline error as JSON. SvelteKit takes a
 *   non-ok data response's JSON body as the page's error as it is (no `handleError`), so the error
 *   view renders the same designed offline state hooks.client.ts gives a failed fetch.
 */
import { NAVIGATION_TIMEOUT_MS } from './workout/launch';

/** How long a client-side data load waits for the server's answer: a navigation's wait. */
export const DATA_TIMEOUT_MS = NAVIGATION_TIMEOUT_MS;

/** SvelteKit's client-side data request for a route (a GET of `<path>/__data.json`). */
export const isDataRequest = (url: URL) => url.pathname.endsWith('/__data.json');

/** The error hooks.client.ts makes of a failed network request (App.Error, `offline` set). */
export const OFFLINE_ERROR = { message: "You're offline", offline: true } as const;

/** The data load's answer when the server cannot be reached in time. */
export const offlineDataResponse = () =>
	new Response(JSON.stringify(OFFLINE_ERROR), {
		status: 503,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});

/** `work`, or a rejection once `ms` have passed without its answer. */
export function withinTime<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeUp = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error('timed out')), ms);
	});
	return Promise.race([work, timeUp]).finally(() => clearTimeout(timer));
}

/**
 * A client-side data load from the network: the server's answer (any status: its own errors and
 * redirects are the app's), or the offline error once DATA_TIMEOUT_MS pass or the request fails.
 * The wait covers the response's headers only; a streamed body then takes the time it needs.
 */
export async function loadData(
	request: Request,
	fetchIt: (request: Request) => Promise<Response> = (r) => fetch(r),
	ms = DATA_TIMEOUT_MS
): Promise<Response> {
	try {
		return await withinTime(fetchIt(request), ms);
	} catch {
		return offlineDataResponse();
	}
}

/**
 * A navigation's network answer: the navigation preload's response (FetchEvent.preloadResponse)
 * when the browser made one, otherwise (preload off or unsupported, or a preload that failed) a
 * fetch of its own.
 */
export async function fromNetwork(
	request: Request,
	preload: Promise<Response | undefined> | undefined,
	fetchIt: (request: Request) => Promise<Response> = (r) => fetch(r)
): Promise<Response> {
	const preloaded = await preload?.catch(() => undefined);
	return preloaded ?? fetchIt(request);
}
