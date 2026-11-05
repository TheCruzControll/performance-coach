/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/**
 * Service worker: precache the app shell and static assets per build version, clean up old
 * versions on activate, and serve:
 *   - build assets + static files  → cache-first (immutable, versioned)
 *   - page navigations             → network-first, fall back to the cached page, then /offline
 *   - /api/*                       → network only (never cached: live, private data)
 */
import { version } from '$app/env';
import { assets, immutable, prerendered } from '$app/manifest';
import { self } from '$app/service-worker';

const PREFIX = 'pc-';
const SHELL_CACHE = `${PREFIX}shell-${version}`;
const PAGES_CACHE = `${PREFIX}pages-${version}`;
const OFFLINE_URL = '/offline';
const NAVIGATION_TIMEOUT_MS = 4000;

const PRECACHE = [
	...immutable.map((f) => f.path),
	...assets.map((f) => f.path),
	...prerendered.map((f) => f.path)
].map((path) => new URL(path, self.registration.scope).pathname);

const PRECACHED = new Set(PRECACHE);

self.addEventListener('install', (event) => {
	event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key.startsWith(PREFIX) && key !== SHELL_CACHE && key !== PAGES_CACHE) {
					await caches.delete(key);
				}
			}
		})()
	);
});

async function cacheFirst(request: Request): Promise<Response> {
	const cached = await caches.match(request, { cacheName: SHELL_CACHE });
	return cached ?? fetch(request);
}

async function networkFirstPage(request: Request): Promise<Response> {
	const cache = await caches.open(PAGES_CACHE);
	try {
		const response = await Promise.race([
			fetch(request),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error('navigation timeout')), NAVIGATION_TIMEOUT_MS)
			)
		]);
		if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
		return response;
	} catch {
		const cached = (await cache.match(request)) ?? (await caches.match(OFFLINE_URL));
		return (
			cached ?? new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } })
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
		event.respondWith(networkFirstPage(request));
	}
});
