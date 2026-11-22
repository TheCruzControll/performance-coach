/**
 * The write-up's views (write-up.ts) and its browser half (write-up-client.ts) on a stubbed
 * endpoint: the request on idle, busy followed by polls at 2, 4 and 8 s then every 8 s up to the
 * coach's duration, a run that ends unstored, every refusal's notice, and a page that leaves.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COACH_MAX_DURATION_S } from '#lib/domain/coach/budgets.ts';
import type { CompletedBlock } from '#lib/domain/coach/events.ts';
import { follow, request } from './write-up-client';
import {
	linesOf,
	noticeOf,
	pollDelaysMs,
	viewOfPoll,
	viewOfReply,
	type NarrationView
} from './write-up';

const TARGET = { kind: 'weekly', id: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b' } as const;
const BLOCKS = [{ block: 0, kind: 'fact', grounded: true, ast: [] }] as unknown as CompletedBlock[];
const WRITTEN = { narrative: 'Fact: You completed 5 of 6 sessions.', blocks: BLOCKS };

afterEach(() => vi.unstubAllGlobals());

describe('pollDelaysMs', () => {
	it('waits 2, 4 and 8 s, then every 8 s, up to the coach’s duration and no further', () => {
		const delays = pollDelaysMs();
		expect(delays.slice(0, 5)).toEqual([2_000, 4_000, 8_000, 8_000, 8_000]);
		expect(delays.reduce((a, b) => a + b, 0)).toBe(COACH_MAX_DURATION_S * 1000);
		expect(pollDelaysMs(20)).toEqual([2_000, 4_000, 8_000, 6_000]);
	});
});

describe('the views', () => {
	it('a reply: written, busy (poll), or each refusal in words', () => {
		expect(viewOfReply({ outcome: 'written', ...WRITTEN })).toEqual({
			state: 'written',
			text: WRITTEN.narrative,
			blocks: BLOCKS
		});
		expect(viewOfReply({ outcome: 'unavailable', reason: 'busy', runId: 'r' })).toEqual({
			state: 'writing',
			ask: false
		});
		expect(viewOfReply({ outcome: 'unavailable', reason: 'not_launched' })).toMatchObject({
			title: 'Your coach is getting ready',
			action: null
		});
		expect(viewOfReply({ outcome: 'unavailable', reason: 'budget' })).toMatchObject({
			title: 'Today’s coach budget is used up',
			action: null
		});
		expect(viewOfReply({ outcome: 'unavailable', reason: 'rate_limited' })).toMatchObject({
			action: 'Try again'
		});
		expect(viewOfReply({ outcome: 'failed' })).toMatchObject({
			title: 'Couldn’t write this up',
			action: 'Try again'
		});
		// Refreshed in another tab since this page loaded: reload, not a Retry that fails again.
		expect(viewOfReply({ outcome: 'superseded' })).toMatchObject({
			title: 'This review has been refreshed',
			action: null
		});
		// Any other reason (no key, the mock in production) is the coach being unavailable.
		expect(viewOfReply({ outcome: 'unavailable', reason: 'no_key' })).toEqual(
			noticeOf('unavailable')
		);
		expect(noticeOf('constructor')).toEqual(noticeOf('unavailable'));
	});

	it('every notice says the review itself is complete', () => {
		for (const reason of ['not_launched', 'disabled', 'budget', 'rate_limited', 'failed']) {
			const view = noticeOf(reason);
			expect(view.state === 'notice' && view.detail, reason).toMatch(
				/^The figures above are complete\./
			);
		}
	});

	it('the server’s words: each paragraph of the write-up, or one line', () => {
		expect(
			linesOf({ state: 'written', text: 'Fact: A.\n\nRecommendation: B.', blocks: [] })
		).toEqual(['Fact: A.', 'Recommendation: B.']);
		expect(linesOf({ state: 'writing', ask: true })).toEqual(['Your coach is writing this up…']);
		expect(linesOf(noticeOf('disabled'))).toEqual([
			'The coach is switched off. The figures above are complete.'
		]);
	});

	it('a poll: written, still running, or ended with nothing stored (a failure)', () => {
		expect(viewOfPoll({ state: 'written', ...WRITTEN })).toMatchObject({ state: 'written' });
		expect(viewOfPoll({ state: 'running' })).toEqual({ state: 'writing', ask: false });
		expect(viewOfPoll({ state: 'none' })).toMatchObject({ action: 'Try again' });
	});
});

/** A stubbed endpoint answering each call from `answers` in turn, recording what was asked. */
function endpoint(answers: { status?: number; body: unknown }[]) {
	const calls: { url: string; method: string; body?: string }[] = [];
	const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
		calls.push({ url, method: init.method ?? 'GET', body: init.body as string | undefined });
		const next = answers.shift();
		if (!next) throw new TypeError('offline');
		return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
	});
	return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

function io(fetch: typeof globalThis.fetch, stop = new AbortController()) {
	const views: NarrationView[] = [];
	const waits: number[] = [];
	return {
		views,
		waits,
		stop,
		io: {
			set: (view: NarrationView) => views.push(view),
			signal: stop.signal,
			fetch,
			wait: async (ms: number) => void waits.push(ms),
			idle: async () => {}
		}
	};
}

describe('write-up-client', () => {
	it('requests a review with none once, on idle, and shows what was written', async () => {
		const api = endpoint([{ body: { outcome: 'written', runId: 'r', ...WRITTEN } }]);
		const t = io(api.fetch);
		await follow(TARGET, { state: 'writing', ask: true }, t.io);
		expect(api.calls).toEqual([
			{ url: '/api/reviews/narrate', method: 'POST', body: JSON.stringify(TARGET) }
		]);
		expect(t.views.at(-1)).toEqual({ state: 'written', text: WRITTEN.narrative, blocks: BLOCKS });
	});

	it('asks nothing for a write-up already there, or a notice the server rendered', async () => {
		const api = endpoint([]);
		const t = io(api.fetch);
		await follow(TARGET, { state: 'written', text: 'x', blocks: [] }, t.io);
		await follow(TARGET, noticeOf('not_launched'), t.io);
		expect(api.calls).toEqual([]);
	});

	it('busy: polls at 2, 4 and 8 s, then every 8 s, until the write-up is stored', async () => {
		const running = { body: { state: 'running', runId: 'r' } };
		const api = endpoint([
			{ body: { outcome: 'unavailable', reason: 'busy', runId: 'r' } },
			running,
			running,
			running,
			running,
			{ body: { state: 'written', ...WRITTEN } }
		]);
		const t = io(api.fetch);
		await request(TARGET, t.io);
		expect(t.waits).toEqual([2_000, 4_000, 8_000, 8_000, 8_000]);
		expect(api.calls.slice(1).map((c) => [c.method, c.url])).toEqual(
			Array(5).fill(['GET', `/api/reviews/narrate?kind=weekly&id=${TARGET.id}`])
		);
		expect(t.views.at(-1)).toMatchObject({ state: 'written', text: WRITTEN.narrative });
	});

	it('a second tab follows the run already going without starting one', async () => {
		const api = endpoint([{ body: { state: 'written', ...WRITTEN } }]);
		const t = io(api.fetch);
		await follow(TARGET, { state: 'writing', ask: false }, t.io);
		expect(api.calls.map((c) => c.method)).toEqual(['GET']);
		expect(t.views.at(-1)).toMatchObject({ state: 'written' });
	});

	it('a run that outlasts the coach’s duration, or ends unstored, is a failure with Retry', async () => {
		const forever = pollDelaysMs().map(() => ({ body: { state: 'running' } }));
		const slow = io(endpoint(forever).fetch);
		await follow(TARGET, { state: 'writing', ask: false }, slow.io);
		expect(slow.waits.reduce((a, b) => a + b, 0)).toBe(COACH_MAX_DURATION_S * 1000);
		expect(slow.views.at(-1)).toEqual(noticeOf('failed'));

		const ended = io(endpoint([{ body: { state: 'none' } }]).fetch);
		await follow(TARGET, { state: 'writing', ask: false }, ended.io);
		expect(ended.views.at(-1)).toEqual(noticeOf('failed'));
	});

	it('a refusal is its notice; a failed request is offline or a failure', async () => {
		const budget = io(endpoint([{ body: { outcome: 'unavailable', reason: 'budget' } }]).fetch);
		await request(TARGET, budget.io);
		expect(budget.views).toEqual([{ state: 'writing', ask: false }, noticeOf('budget')]);

		vi.stubGlobal('navigator', { onLine: true });
		const broken = io(endpoint([{ status: 500, body: {} }]).fetch);
		await request(TARGET, broken.io);
		expect(broken.views.at(-1)).toEqual(noticeOf('failed'));

		vi.stubGlobal('navigator', { onLine: false });
		const offline = io(endpoint([]).fetch);
		await request(TARGET, offline.io);
		expect(offline.views.at(-1)).toEqual(noticeOf('offline'));
	});

	it('stops once the review leaves the page', async () => {
		const api = endpoint([{ body: { state: 'running' } }]);
		const t = io(api.fetch);
		t.stop.abort();
		await follow(TARGET, { state: 'writing', ask: false }, t.io);
		await follow(TARGET, { state: 'writing', ask: true }, t.io);
		expect(api.calls).toEqual([]);
		expect(t.views).toEqual([]);
	});
});
