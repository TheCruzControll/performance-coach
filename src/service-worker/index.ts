/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/**
 * Service worker: precache the app shell and static assets per build version, clean up old
 * versions on activate (and take control of already-open pages), and serve:
 *   - build assets + static files  → cache-first (immutable, versioned)
 *   - page navigations             → network only; on failure the prerendered /offline screen
 *   - /api/*, __data.json          → network only (never cached: live, private data)
 *
 * Dynamic HTML is never stored: pages are sent `private, no-cache` because they carry personal
 * data, and a stored copy would outlive sign-out and show stale state (e.g. a health check) as
 * if it were live. Offline workout data (M4) will live in IndexedDB, owned by the app.
 */
import { version } from '$app/env';
import { assets, immutable, prerendered } from '$app/manifest';
import { self } from '$app/service-worker';

const PREFIX = 'pc-';
const SHELL_CACHE = `${PREFIX}shell-${version}`;
const OFFLINE_URL = '/offline';
/** A connected-but-dead network ("lie-fi") can hang a request for a minute; give up sooner. */
const NAVIGATION_TIMEOUT_MS = 6000;

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
			// Control the page that installed us (the first visit), so offline support starts
			// now rather than after the next navigation.
			await self.clients.claim();
		})()
	);
});

async function cacheFirst(request: Request): Promise<Response> {
	const cached = await caches.match(request, { cacheName: SHELL_CACHE });
	return cached ?? fetch(request);
}

async function navigate(request: Request): Promise<Response> {
	try {
		return await Promise.race([
			fetch(request),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error('navigation timeout')), NAVIGATION_TIMEOUT_MS)
			)
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
		event.respondWith(cacheFirst(request));
	} else if (request.mode === 'navigate') {
		event.respondWith(navigate(request));
	}
});
