/**
 * The service worker's build cache (sw-precache.ts): install copies the hashed files the previous
 * version cached and downloads only the rest; a build file outside the precache is cached on first
 * use and served from the cache after that.
 */
import { describe, expect, it } from 'vitest';
import { cacheFirst, isHashed, precache, precacheList } from './sw-precache';

const ORIGIN = 'https://coach.test';
const SCOPE = `${ORIGIN}/`;

/** CacheStorage in memory, in the parts the worker uses; `network` serves and records fetches. */
function storage(network: (path: string) => Response = (p) => new Response(`net ${p}`)) {
	const fetched: string[] = [];
	const stores = new Map<string, Map<string, Response>>();
	const key = (request: RequestInfo | URL) =>
		new URL(request instanceof Request ? request.url : String(request), ORIGIN);
	const fetchIt = async (request: RequestInfo | URL) => {
		const { pathname } = key(request);
		fetched.push(pathname);
		return network(pathname);
	};
	const open = (name: string) => {
		let store = stores.get(name);
		if (!store) stores.set(name, (store = new Map()));
		const entries = store;
		const cache = {
			async match(request: RequestInfo | URL, options?: CacheQueryOptions) {
				const url = key(request);
				const found = options?.ignoreSearch
					? [...entries].find(([k]) => new URL(k).pathname === url.pathname)?.[1]
					: entries.get(url.href);
				return found?.clone();
			},
			async put(request: RequestInfo | URL, response: Response) {
				entries.set(key(request).href, response.clone());
			},
			async addAll(requests: string[]) {
				const responses = await Promise.all(requests.map(fetchIt));
				if (responses.some((r) => !r.ok)) throw new TypeError('addAll: a request failed');
				requests.forEach((r, i) => entries.set(key(r).href, responses[i]!));
			},
			async keys() {
				return [...entries.keys()].map((href) => new Request(href));
			}
		};
		return cache;
	};
	const caches = {
		open: async (name: string) => open(name),
		keys: async () => [...stores.keys()],
		has: async (name: string) => stores.has(name),
		delete: async (name: string) => stores.delete(name),
		async match(request: RequestInfo | URL, options?: MultiCacheQueryOptions) {
			const names = options?.cacheName ? [options.cacheName] : [...stores.keys()];
			for (const name of names) {
				if (!stores.has(name)) continue;
				const found = await open(name).match(request, options);
				if (found) return found;
			}
			return undefined;
		}
	} as unknown as CacheStorage;
	/** Puts `paths` into cache `name` as `body` (an older version's cache). */
	const seed = async (name: string, paths: string[], body = 'old') => {
		for (const p of paths) await open(name).put(p, new Response(`${body} ${p}`));
	};
	const text = async (name: string, path: string) => (await open(name).match(path))?.text() ?? null;
	const paths = async (name: string) =>
		(await open(name).keys()).map((r) => new URL(r.url).pathname).sort();
	return { caches, fetched, fetchIt, seed, text, paths };
}

const OLD = 'pc-shell-1.0.0+aaaaaaa';
const NEW = 'pc-shell-1.0.0+bbbbbbb';
const KEPT = '/_app/immutable/chunks/kept.js';
const CHANGED = '/_app/immutable/chunks/changed.B.js';
const OFFLINE = '/offline';
const MANIFEST = '/manifest.webmanifest';

describe('precacheList', () => {
	it("takes paths relative to the worker's scope to pathnames, once each", () => {
		expect(
			precacheList(SCOPE, ['_app/immutable/entry/app.js', 'offline', '/offline', 'brand/mark.svg'])
		).toEqual(['/_app/immutable/entry/app.js', '/offline', '/brand/mark.svg']);
	});

	it('leaves out the home-screen icons', () => {
		expect(precacheList(SCOPE, ['icons/icon-512.png', 'favicon.svg'])).toEqual(['/favicon.svg']);
	});
});

describe('isHashed', () => {
	it('is the build files only: static files and pages keep their names when they change', () => {
		expect(isHashed('/_app/immutable/chunks/a.B1c2.js')).toBe(true);
		expect(isHashed('/offline')).toBe(false);
		expect(isHashed('/manifest.webmanifest')).toBe(false);
		expect(isHashed('/_app/version.json')).toBe(false);
	});
});

describe('precache', () => {
	const options = {
		name: NEW,
		prefix: 'pc-shell-',
		paths: [KEPT, CHANGED, OFFLINE, MANIFEST],
		hashed: new Set([KEPT, CHANGED])
	};

	it('copies an unchanged hashed file from the previous version and downloads only the rest', async () => {
		const s = storage();
		await s.seed(OLD, [KEPT, '/_app/immutable/chunks/changed.A.js', OFFLINE, MANIFEST]);

		expect(await precache(s.caches, options)).toEqual({ reused: 1, fetched: 3 });
		expect(s.fetched.sort()).toEqual([CHANGED, MANIFEST, OFFLINE].sort());
		expect(await s.text(NEW, KEPT)).toBe(`old ${KEPT}`);
		expect(await s.text(NEW, CHANGED)).toBe(`net ${CHANGED}`);
	});

	it('downloads the static files and pages again: their names do not change with their bytes', async () => {
		const s = storage();
		await s.seed(OLD, [OFFLINE, MANIFEST]);

		await precache(s.caches, { ...options, hashed: new Set([KEPT, CHANGED, OFFLINE, MANIFEST]) });
		expect(await s.text(NEW, OFFLINE)).toBe(`net ${OFFLINE}`);
		expect(await s.text(NEW, MANIFEST)).toBe(`net ${MANIFEST}`);
	});

	it('carries over a build file the old version cached on use, while this build still has it', async () => {
		const s = storage();
		const lazy = '/_app/immutable/chunks/lazy.js';
		const gone = '/_app/immutable/chunks/gone.js';
		await s.seed(OLD, [lazy, gone]);

		await precache(s.caches, { ...options, hashed: new Set([KEPT, CHANGED, lazy]) });
		expect(await s.text(NEW, lazy)).toBe(`old ${lazy}`);
		expect(await s.paths(NEW)).toEqual([KEPT, CHANGED, lazy, MANIFEST, OFFLINE].sort());
	});

	it("takes nothing from a cache that is not one of the worker's versions", async () => {
		const s = storage();
		await s.seed('pc-other', [KEPT]);
		await s.seed('someone-else', [CHANGED]);

		expect(await precache(s.caches, options)).toEqual({ reused: 0, fetched: 4 });
		expect(await s.text(NEW, KEPT)).toBe(`net ${KEPT}`);
	});

	it('reads every older version: a file is copied once, from whichever holds it', async () => {
		const s = storage();
		await s.seed('pc-shell-0.9.0+0000000', [KEPT], 'oldest');
		await s.seed(OLD, [KEPT, CHANGED]);

		expect(await precache(s.caches, options)).toEqual({ reused: 2, fetched: 2 });
		expect(s.fetched.sort()).toEqual([MANIFEST, OFFLINE].sort());
	});

	it('fails the install when a download fails', async () => {
		const s = storage((p) => new Response('', { status: p === OFFLINE ? 503 : 200 }));
		await expect(precache(s.caches, options)).rejects.toThrow(TypeError);
	});
});

describe('cacheFirst', () => {
	const LAZY = '/_app/immutable/chunks/sheet.js';
	const request = (path: string, init?: RequestInit) => new Request(`${ORIGIN}${path}`, init);

	it('answers from the cache without the network', async () => {
		const s = storage();
		await s.seed(NEW, [KEPT]);
		const response = await cacheFirst(s.caches, request(KEPT), {
			cacheName: NEW,
			fetchIt: s.fetchIt
		});
		expect(await response.text()).toBe(`old ${KEPT}`);
		expect(s.fetched).toEqual([]);
	});

	it('stores a build file on first use, then serves it with no network', async () => {
		const s = storage();
		const kept: Promise<unknown>[] = [];
		const first = await cacheFirst(s.caches, request(LAZY), {
			cacheName: NEW,
			store: true,
			waitUntil: (work) => kept.push(work),
			fetchIt: s.fetchIt
		});
		expect(await first.text()).toBe(`net ${LAZY}`);
		expect(kept).toHaveLength(1);
		await Promise.all(kept);

		const offline = storage(() => {
			throw new TypeError('Failed to fetch');
		});
		const again = await cacheFirst(s.caches, request(LAZY), {
			cacheName: NEW,
			fetchIt: offline.fetchIt
		});
		expect(await again.text()).toBe(`net ${LAZY}`);
		expect(s.fetched).toEqual([LAZY]);
	});

	it('never stores a failed answer, nor anything it was not asked to store', async () => {
		const s = storage((p) => new Response('nope', { status: p === LAZY ? 404 : 200 }));
		const kept: Promise<unknown>[] = [];
		const waitUntil = (work: Promise<unknown>) => kept.push(work);
		await cacheFirst(s.caches, request(LAZY), {
			cacheName: NEW,
			store: true,
			waitUntil,
			fetchIt: s.fetchIt
		});
		await cacheFirst(s.caches, request('/robots.txt'), {
			cacheName: NEW,
			waitUntil,
			fetchIt: s.fetchIt
		});
		await Promise.all(kept);
		expect(await s.paths(NEW)).toEqual([]);
	});

	it('serves a prerendered page whatever its query string', async () => {
		const s = storage();
		await s.seed(NEW, ['/workout']);
		const response = await cacheFirst(s.caches, request('/workout?start=2026-11-11'), {
			cacheName: NEW,
			ignoreSearch: true,
			fetchIt: s.fetchIt
		});
		expect(await response.text()).toBe('old /workout');
		expect(s.fetched).toEqual([]);
	});

	it("answers only from this version's cache", async () => {
		const s = storage();
		await s.seed(OLD, [KEPT]);
		const response = await cacheFirst(s.caches, request(KEPT), {
			cacheName: NEW,
			fetchIt: s.fetchIt
		});
		expect(await response.text()).toBe(`net ${KEPT}`);
	});
});
