import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DATA_TIMEOUT_MS,
	fromNetwork,
	isDataRequest,
	loadData,
	OFFLINE_ERROR,
	offlineDataResponse,
	withinTime
} from './sw-network';
import { NAVIGATION_TIMEOUT_MS } from './workout/launch';

const ORIGIN = 'https://coach.test';
const dataRequest = (path = '/profile/__data.json?x-sveltekit-invalidated=01') =>
	new Request(`${ORIGIN}${path}`);

/** A network that never answers (lie-fi), recording what it was asked. */
function hangingNetwork() {
	const asked: string[] = [];
	return {
		asked,
		fetchIt: (request: Request) => {
			asked.push(request.url);
			return new Promise<Response>(() => {});
		}
	};
}

/** Settles every pending promise callback (no timers). */
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve)).then(() => undefined);

describe('isDataRequest', () => {
	it("is SvelteKit's data request for any route, whatever its query", () => {
		expect(isDataRequest(new URL(`${ORIGIN}/__data.json`))).toBe(true);
		expect(isDataRequest(new URL(`${ORIGIN}/today/__data.json`))).toBe(true);
		expect(
			isDataRequest(new URL(`${ORIGIN}/progress/workouts/__data.json?x-sveltekit-invalidated=1`))
		).toBe(true);
	});

	it('is nothing else', () => {
		for (const path of [
			'/today',
			'/api/health',
			'/data.json',
			'/today/__data.json/x',
			'/x__data'
		]) {
			expect(isDataRequest(new URL(`${ORIGIN}${path}`)), path).toBe(false);
		}
	});
});

describe('the offline data answer', () => {
	it("is a 503 whose JSON body is hooks.client's offline error, so the offline state renders", async () => {
		const response = offlineDataResponse();
		expect(response.status).toBe(503);
		expect(response.ok).toBe(false);
		// SvelteKit reads the body as the page's error only when the type says JSON.
		expect(response.headers.get('content-type')).toContain('application/json');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({ message: "You're offline", offline: true });
	});

	it('matches the error hooks.client.ts gives a failed fetch, word for word', () => {
		const hooks = readFileSync(new URL('../../hooks.client.ts', import.meta.url), 'utf8');
		expect(hooks).toContain(
			`return { message: ${JSON.stringify(OFFLINE_ERROR.message)}, offline: true };`
		);
	});
});

describe('loadData (a client-side data load)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('waits as long as a navigation does', () => {
		expect(DATA_TIMEOUT_MS).toBe(NAVIGATION_TIMEOUT_MS);
	});

	it('passes the server answer through, its errors included', async () => {
		for (const status of [200, 404, 500]) {
			const body = JSON.stringify({ type: 'data', status });
			const answer = new Response(body, { status });
			const fetchIt = vi.fn(async () => answer);
			const request = dataRequest();
			const response = await loadData(request, fetchIt);
			expect(response).toBe(answer);
			expect(fetchIt).toHaveBeenCalledWith(request);
		}
	});

	it('on lie-fi, gives up after DATA_TIMEOUT_MS with the offline answer, not before', async () => {
		const network = hangingNetwork();
		let settled: Response | undefined;
		void loadData(dataRequest(), network.fetchIt).then((r) => (settled = r));
		expect(network.asked).toEqual([`${ORIGIN}/profile/__data.json?x-sveltekit-invalidated=01`]);

		await vi.advanceTimersByTimeAsync(DATA_TIMEOUT_MS - 1);
		expect(settled).toBeUndefined();

		await vi.advanceTimersByTimeAsync(1);
		expect(settled?.status).toBe(503);
		expect(await settled?.json()).toEqual(OFFLINE_ERROR);
	});

	it('answers offline at once when the request fails (no signal, connection refused)', async () => {
		const response = await loadData(dataRequest(), async () => {
			throw new TypeError('Failed to fetch');
		});
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual(OFFLINE_ERROR);
		expect(vi.getTimerCount()).toBe(0); // its timer is cleared too
	});

	it('clears its timer once the server answers', async () => {
		await loadData(dataRequest(), async () => new Response('{}'));
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('withinTime', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('rejects once the time is up, and keeps an answer that came in time', async () => {
		const late = withinTime(new Promise(() => {}), 50);
		const check = expect(late).rejects.toThrow('timed out');
		await vi.advanceTimersByTimeAsync(50);
		await check;

		await expect(withinTime(Promise.resolve('ok'), 50)).resolves.toBe('ok');
	});
});

describe('fromNetwork (a navigation)', () => {
	const page = new Request(`${ORIGIN}/today`);

	it("uses the browser's navigation preload, without a second request", async () => {
		const preloaded = new Response('<!doctype html>');
		const fetchIt = vi.fn(async () => new Response('second'));
		expect(await fromNetwork(page, Promise.resolve(preloaded), fetchIt)).toBe(preloaded);
		expect(fetchIt).not.toHaveBeenCalled();
	});

	it('fetches when there is no preload (off, unsupported, or a precached page)', async () => {
		const fetched = new Response('fetched');
		for (const preload of [undefined, Promise.resolve(undefined)]) {
			const fetchIt = vi.fn(async () => fetched);
			expect(await fromNetwork(page, preload, fetchIt)).toBe(fetched);
			expect(fetchIt).toHaveBeenCalledWith(page);
		}
	});

	it('fetches when the preload failed', async () => {
		const fetched = new Response('fetched');
		const fetchIt = vi.fn(async () => fetched);
		const failed = Promise.reject(new TypeError('preload failed'));
		expect(await fromNetwork(page, failed, fetchIt)).toBe(fetched);
	});

	it('rejects when the network fails too, so navigate serves the offline screen', async () => {
		const failed = Promise.reject(new TypeError('Failed to fetch'));
		await expect(
			fromNetwork(page, failed, async () => {
				throw new TypeError('Failed to fetch');
			})
		).rejects.toThrow(TypeError);
	});

	it('waits for the preload rather than racing a fetch beside it', async () => {
		let answer!: (r: Response) => void;
		const preload = new Promise<Response>((resolve) => (answer = resolve));
		const fetchIt = vi.fn(async () => new Response('second'));
		const result = fromNetwork(page, preload, fetchIt);
		await flush();
		expect(fetchIt).not.toHaveBeenCalled();
		const preloaded = new Response('preloaded');
		answer(preloaded);
		expect(await result).toBe(preloaded);
	});
});

describe('the service worker', () => {
	const worker = readFileSync(new URL('../../service-worker/index.ts', import.meta.url), 'utf8');

	it('enables navigation preload on activate, and hands each navigation its preload', () => {
		const activate = worker.slice(worker.indexOf("addEventListener('activate'"));
		expect(activate.slice(0, activate.indexOf('clients.claim()'))).toContain(
			'navigationPreload?.enable()'
		);
		expect(worker).toContain('navigate(request, event.preloadResponse)');
		expect(worker).toMatch(/fromNetwork\(request, preload\)/);
	});

	it('answers client-side data loads with loadData', () => {
		expect(worker).toMatch(
			/isDataRequest\(url\)\)\s*\{\s*event\.respondWith\(loadData\(request\)\)/
		);
	});
});
