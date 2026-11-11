/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/**
 * Service worker: precache the app shell and static assets per build version, clean up old
 * versions on activate (and take control of already-open pages), and serve:
 *   - build assets + static files  → cache-first (immutable, versioned)
 *   - prerendered pages            → cache-first, whatever the query string, so a workout page
 *                                    (/workout?start=…) reloads offline from the precache
 *   - page navigations             → network only, through the navigation preload (enabled on
 *                                    activate) when the browser made one; on failure the
 *                                    prerendered /offline screen, which sends a launch
 *                                    mid-workout to the workout (lib/client/workout/launch.ts),
 *                                    sooner for the start URL
 *   - __data.json                  → network only, with a bounded wait: past it, or on failure,
 *                                    a 503 carrying the offline error (lib/client/sw-network.ts)
 *   - /api/*                       → not handled (network only; never cached: live, private data)
 *
 * Dynamic HTML is never stored: pages are sent `private, no-cache` because they carry personal
 * data, and a stored copy would outlive sign-out and show stale state (e.g. a health check) as
 * if it were live. Offline workout data (M4) will live in IndexedDB, owned by the app.
 */
import { version } from '$app/env';
import { assets, immutable, prerendered } from '$app/manifest';
import { self } from '$app/service-worker';
import { fromNetwork, isDataRequest, loadData } from '#lib/client/sw-network.ts';
import { navigationTimeout } from '#lib/client/workout/launch.ts';
import { activeSummary } from '#lib/client/workout/probe.ts';

const PREFIX = 'pc-';
const SHELL_CACHE = `${PREFIX}shell-${version}`;
const OFFLINE_URL = '/offline';

/**
 * Home-screen/manifest icons (~280 KB of PNGs) are fetched by the OS when the app is
 * installed and never displayed by the running app: keep them out of the install download.
 */
const NOT_PRECACHED = /^\/icons\//;

const PRECACHE = [
	...immutable.map((f) => f.path),
	...assets.map((f) => f.path),
	...prerendered.map((f) => f.path)
]
	.map((path) => new URL(path, self.registration.scope).pathname)
	.filter((path) => !NOT_PRECACHED.test(path));

const PRECACHED = new Set(PRECACHE);

self.addEventListener('install', (event) => {
	event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			// Drops previous versions, including the page snapshots older builds stored.
			for (const key of await caches.keys()) {
				if (key.startsWith(PREFIX) && key !== SHELL_CACHE) await caches.delete(key);
			}
			// A server-rendered navigation's request starts while this worker boots, not after it
			// (preloadResponse in navigate). Where it is unsupported or refused, navigate fetches as
			// before; it never stands in the way of claiming the open pages below.
			await self.registration.navigationPreload?.enable().catch(() => {});
			// Control the page that installed us (the first visit), so offline support starts
			// now rather than after the next navigation.
			await self.clients.claim();
		})()
	);
});

async function cacheFirst(request: Request): Promise<Response> {
	// A navigation here is to a prerendered page: the same data-free HTML for every query.
	const ignoreSearch = request.mode === 'navigate';
	const cached = await caches.match(request, { cacheName: SHELL_CACHE, ignoreSearch });
	return cached ?? fetch(request);
}

/** Whether a workout is in progress on this device (its IndexedDB, read without creating it). */
const workoutInProgress = async () => (await activeSummary()) !== null;

/**
 * Rejects once the navigation's time is up (launch.ts navigationTimeout): a lie-fi network can hang
 * it for a minute. Counted from the request, while IndexedDB answers whether a workout is on.
 */
async function timeUp(pathname: string): Promise<never> {
	const asked = Date.now();
	const ms = await navigationTimeout(pathname, workoutInProgress);
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms - (Date.now() - asked))));
	throw new Error('navigation timeout');
}

async function navigate(
	request: Request,
	preload: Promise<Response | undefined> | undefined
): Promise<Response> {
	try {
		return await Promise.race([
			fromNetwork(request, preload),
			timeUp(new URL(request.url).pathname)
		]);
	} catch {
		// The offline screen holds no personal data; it renders in the app shell at the URL
		// that failed, so tabs without server data keep working from the precache.
		const offline = await caches.match(OFFLINE_URL, { cacheName: SHELL_CACHE });
		return (
			offline ?? new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } })
		);
	}
}

self.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	if (url.pathname.startsWith('/api/')) return;

	if (PRECACHED.has(url.pathname)) {
		// A navigation here leaves its preload unused: the browser cancels it.
		event.respondWith(cacheFirst(request));
	} else if (request.mode === 'navigate') {
		event.respondWith(navigate(request, event.preloadResponse));
	} else if (isDataRequest(url)) {
		event.respondWith(loadData(request));
	}
});
