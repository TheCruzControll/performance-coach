import { describe, expect, it, vi } from 'vitest';
import { encodeSse, type CoachEvent } from '#lib/domain/coach/events.ts';
import { cancelRun, settleRun, streamTurn, type TurnRequest } from './stream';

const REQUEST: TurnRequest = {
	threadId: null,
	clientMessageId: '00000000-0000-4000-8000-000000000001',
	text: 'How has my bench progressed this month?'
};

const STARTED: CoachEvent = {
	type: 'run_started',
	threadId: '00000000-0000-4000-8000-0000000000a1',
	runId: '00000000-0000-4000-8000-0000000000b1',
	messageId: '00000000-0000-4000-8000-0000000000c1'
};
const DELTA: CoachEvent = { type: 'text_delta', block: 0, text: 'Your bench went up 😀' };
const DONE: CoachEvent = { type: 'done', status: 'completed' };

/** A 200 event stream whose body arrives in `chunks`, then closes (or errors). */
function sse(chunks: (string | Uint8Array)[], end: 'close' | 'error' = 'close'): Response {
	const encoder = new TextEncoder();
	const queue = [...chunks];
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			const chunk = queue.shift();
			if (chunk !== undefined)
				controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
			else if (end === 'close') controller.close();
			else controller.error(new TypeError('network error'));
		}
	});
	return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const frames = (...events: CoachEvent[]) =>
	events.map((event, i) => encodeSse(event, i + 1)).join('');

function fetchReturning(response: Response | Promise<Response>) {
	return vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response));
}

describe('streamTurn', () => {
	it('POSTs the turn as JSON and hands over every event in order, across any chunk boundary', async () => {
		const bytes = new TextEncoder().encode(frames(STARTED, DELTA, DONE));
		// Split inside a frame and inside the emoji's four bytes.
		const emoji = bytes.indexOf(0xf0);
		const fetch = fetchReturning(
			sse([bytes.slice(0, 40), bytes.slice(40, emoji + 2), bytes.slice(emoji + 2)])
		);
		const events: CoachEvent[] = [];
		const end = await streamTurn(REQUEST, (event) => events.push(event), {
			signal: new AbortController().signal,
			fetch
		});

		expect(end).toEqual({ kind: 'done', status: 'completed' });
		expect(events).toEqual([STARTED, DELTA, DONE]);
		const [url, init] = fetch.mock.calls[0]!;
		expect(url).toBe('/api/coach/turns');
		expect(init?.method).toBe('POST');
		expect(JSON.parse(init?.body as string)).toEqual(REQUEST);
	});

	it('is dropped when the stream closes or breaks before done, keeping what arrived', async () => {
		for (const end of ['close', 'error'] as const) {
			const events: CoachEvent[] = [];
			const result = await streamTurn(REQUEST, (event) => events.push(event), {
				signal: new AbortController().signal,
				fetch: fetchReturning(sse([frames(STARTED, DELTA)], end))
			});
			expect(result, end).toEqual({ kind: 'dropped' });
			expect(events, end).toEqual([STARTED, DELTA]);
		}
	});

	it('is dropped when the request fails, and aborted when the caller aborted it', async () => {
		const failing = vi.fn<typeof globalThis.fetch>(() =>
			Promise.reject(new TypeError('Failed to fetch'))
		);
		const signal = new AbortController().signal;
		expect(await streamTurn(REQUEST, () => {}, { signal, fetch: failing })).toEqual({
			kind: 'dropped'
		});

		const stop = new AbortController();
		stop.abort();
		const aborting = vi.fn<typeof globalThis.fetch>(() =>
			Promise.reject(new DOMException('', 'AbortError'))
		);
		expect(await streamTurn(REQUEST, () => {}, { signal: stop.signal, fetch: aborting })).toEqual({
			kind: 'aborted'
		});
	});

	it('reports an answer without a stream as refused, with its kind', async () => {
		const call = (response: Response) =>
			streamTurn(REQUEST, () => {}, {
				signal: new AbortController().signal,
				fetch: fetchReturning(response)
			});
		expect(
			await call(new Response('{}', { status: 429, headers: { 'retry-after': '42' } }))
		).toEqual({ kind: 'refused', error: 'rate_limited', retryAfterS: 42 });
		expect(await call(new Response('{}', { status: 400 }))).toEqual({
			kind: 'refused',
			error: 'invalid_request'
		});
		expect(await call(new Response('{}', { status: 500 }))).toEqual({
			kind: 'refused',
			error: 'provider'
		});
	});
});

describe('cancelRun', () => {
	it('POSTs Stop for the run, and a failure is not thrown', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.reject(new TypeError('offline')));
		await expect(cancelRun('run/1', fetch)).resolves.toBeUndefined();
		expect(fetch).toHaveBeenCalledWith('/api/coach/runs/run%2F1/cancel', { method: 'POST' });
	});
});

describe('settleRun', () => {
	const runs = (...list: { id: string; status: string }[]) =>
		new Response(JSON.stringify({ summary: null, runs: list, nextBefore: null }));

	it('asks until the run has finished', async () => {
		const answers = [
			runs({ id: 'b', status: 'running' }, { id: 'a', status: 'completed' }),
			runs({ id: 'b', status: 'running' }),
			runs({ id: 'c', status: 'running' }, { id: 'b', status: 'interrupted' })
		];
		const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(answers.shift()!));
		const sleep = vi.fn(() => Promise.resolve());
		expect(await settleRun('b', { fetch, sleep, everyMs: 100 })).toBe(true);
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(fetch).toHaveBeenCalledWith('/api/coach/runs?limit=5');
		expect(sleep).toHaveBeenCalledWith(100);
	});

	it('without a run id, waits for the newest run', async () => {
		const answers = [runs({ id: 'n', status: 'running' }), runs({ id: 'n', status: 'completed' })];
		const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(answers.shift()!));
		expect(await settleRun(null, { fetch, sleep: () => Promise.resolve() })).toBe(true);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('gives up after its wait, or when the list cannot be read', async () => {
		const still = vi.fn<typeof globalThis.fetch>(() =>
			Promise.resolve(runs({ id: 'b', status: 'running' }))
		);
		const sleep = () => Promise.resolve();
		expect(await settleRun('b', { fetch: still, sleep, waitMs: 1_000, everyMs: 250 })).toBe(false);
		expect(still).toHaveBeenCalledTimes(5);

		const denied = vi.fn<typeof globalThis.fetch>(() =>
			Promise.resolve(new Response('', { status: 429 }))
		);
		expect(await settleRun('b', { fetch: denied, sleep })).toBe(false);
		expect(denied).toHaveBeenCalledTimes(1);
	});

	it('reads the list at most 11 times while a run keeps running, sparing coach.action', async () => {
		const still = vi.fn<typeof globalThis.fetch>(() =>
			Promise.resolve(runs({ id: 'b', status: 'running' }))
		);
		expect(await settleRun('b', { fetch: still, sleep: () => Promise.resolve() })).toBe(false);
		expect(still.mock.calls.length).toBeLessThanOrEqual(11);
	});
});
