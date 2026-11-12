/**
 * The service worker's cache of the build (src/service-worker/index.ts), kept free of `$app/*` so
 * it runs in unit tests.
 *
 * - Install precaches what the app needs offline (scripts/lib/precache-scope.ts picks the build
 *   files) with the static files and prerendered pages. A file under `_app/immutable` is named by
 *   its content's hash, so one the previous version's cache already holds is copied across instead
 *   of downloaded again: after a deploy only the changed files cross the network (precache).
 * - Every other build file is cached the first time a page loads it and served from the cache
 *   after that (cacheFirst): same name, same bytes.
 */

/** The build's content-hashed files: a name never changes its bytes. */
export const isHashed = (pathname: string) => pathname.startsWith('/_app/immutable/');

/**
 * Home-screen/manifest icons (~280 KB of PNGs) are fetched by the OS when the app is installed and
 * never displayed by the running app: keep them out of the install download.
 */
const NOT_PRECACHED = /^\/icons\//;

/** The pathnames to precache: `paths` (relative to the worker's scope) without the icons. */
export function precacheList(scope: string, paths: Iterable<string>): string[] {
	const list = [...paths].map((p) => new URL(p, scope).pathname);
	return [...new Set(list)].filter((p) => !NOT_PRECACHED.test(p));
}

export interface PrecacheOptions {
	/** This version's cache. */
	name: string;
	/** The prefix every version's cache name starts with (`pc-shell-`). */
	prefix: string;
	/** Pathnames to precache. */
	paths: string[];
	/** Hashed pathnames this build has: copied from an older cache whenever it holds one. */
	hashed: ReadonlySet<string>;
}

/**
 * Fills this version's cache: copies the build's hashed files an older version cached (precached
 * or cached on use), then downloads the precache paths still missing. Rejects, failing the
 * install, when a download fails (Cache.addAll), as before.
 */
export async function precache(
	caches: CacheStorage,
	{ name, prefix, paths, hashed }: PrecacheOptions
): Promise<{ reused: number; fetched: number }> {
	const cache = await caches.open(name);
	const copied = new Set<string>();
	for (const key of await caches.keys()) {
		if (!key.startsWith(prefix) || key === name) continue;
		const old = await caches.open(key);
		const copies: Promise<void>[] = [];
		for (const request of await old.keys()) {
			const pathname = new URL(request.url).pathname;
			if (!hashed.has(pathname) || !isHashed(pathname) || copied.has(pathname)) continue;
			copied.add(pathname);
			copies.push(
				old
					.match(request)
					.then((response) => (response ? cache.put(pathname, response) : undefined))
			);
		}
		await Promise.all(copies);
	}
	const missing = paths.filter((p) => !copied.has(p));
	await cache.addAll(missing);
	return { reused: paths.length - missing.length, fetched: missing.length };
}

export interface CacheFirstOptions {
	/** The cache to answer from (and to store in). */
	cacheName: string;
	/** Match whatever the query string (a prerendered page). */
	ignoreSearch?: boolean;
	/** Store the network's answer when the cache has none (a hashed build file). */
	store?: boolean;
	/** Keeps the worker alive while the answer is stored (FetchEvent.waitUntil). */
	waitUntil?: (work: Promise<unknown>) => void;
	fetchIt?: (request: Request) => Promise<Response>;
}

/** The cached answer, or the network's (stored for next time when `store`, if it is a 200). */
export async function cacheFirst(
	caches: CacheStorage,
	request: Request,
	{ cacheName, ignoreSearch = false, store = false, waitUntil, fetchIt = fetch }: CacheFirstOptions
): Promise<Response> {
	const cached = await caches.match(request, { cacheName, ignoreSearch });
	if (cached) return cached;
	const response = await fetchIt(request);
	if (store && response.status === 200) {
		// Cloned now: the page may have read the body by the time the cache opens.
		const copy = response.clone();
		const stored = caches.open(cacheName).then((cache) => cache.put(request, copy));
		waitUntil?.(stored.catch(() => {}));
	}
	return response;
}
