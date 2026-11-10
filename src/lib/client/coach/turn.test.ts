import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeSse, type CoachEvent, type CompletedBlock } from '#lib/domain/coach/events.ts';

const nav = vi.hoisted(() => ({
	goto: vi.fn(() => Promise.resolve()),
	invalidateAll: vi.fn(() => Promise.resolve()),
	page: { params: {} as { thread?: string } }
}));
vi.mock('$app/navigation', () => ({ goto: nav.goto, invalidateAll: nav.invalidateAll }));
vi.mock('$app/paths', () => ({
	resolve: (_route: string, params: { thread?: string }) => `/coach/${params.thread ?? ''}`
}));
vi.mock('$app/state', () => ({ page: nav.page }));

const { CoachTurn, CoachTurns } = await import('./turn.svelte.ts');

const THREAD = '00000000-0000-4000-8000-0000000000a1';
const RUN = '00000000-0000-4000-8000-0000000000b1';
const OWNER = '00000000-0000-4000-8000-0000000000c1';
const ANSWER = '00000000-0000-4000-8000-0000000000d1';

const started: CoachEvent = { type: 'run_started', threadId: THREAD, runId: RUN, messageId: OWNER };
const block = (n: number, text = `Block ${n}`): CompletedBlock => ({
	block: n,
	kind: 'note',
	method: null,
	ast: [{ type: 'text', text }] as CompletedBlock['ast'],
	sources: [],
	grounded: true
});
const completed = (n: number): CoachEvent => ({ type: 'block_completed', ...block(n) });
const ANSWERED: CoachEvent[] = [
	started,
	{ type: 'block_started', block: 0, kind: 'note', method: null },
	{ type: 'text_delta', block: 0, text: 'Block 0' },
	completed(0),
	{ type: 'answer_completed', messageId: ANSWER },
	{ type: 'done', status: 'completed' }
];

/** A frame scheduler the test runs by hand. */
function frames() {
	const queued: (() => void)[] = [];
	return {
		frame: (draw: () => void) => void queued.push(draw),
		run: () => queued.splice(0).forEach((draw) => draw()),
		get pending() {
			return queued.length;
		}
	};
}

const request = (threadId: string | null = null) => ({
	threadId,
	clientMessageId: '00000000-0000-4000-8000-000000000001',
	text: 'How has my bench progressed this month?'
});

/**
 * The server, faked: /api/coach/turns streams `events` (and then closes, or breaks when `drop`,
 * or waits for the request's abort when `hold`); /api/coach/runs says every run has finished.
 */
function server(events: CoachEvent[], { drop = false, hold = false } = {}) {
	const calls: { url: string; at: number }[] = [];
	let at = 0;
	const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
		const url = String(input);
		calls.push({ url, at: at++ });
		if (url.startsWith('/api/coach/runs?'))
			return new Response(JSON.stringify({ runs: [{ id: RUN, status: 'interrupted' }] }));
		if (url.endsWith('/cancel')) return new Response('{"running":true}', { status: 202 });
		const queue = events.map((event, i) => new TextEncoder().encode(encodeSse(event, i + 1)));
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				const chunk = queue.shift();
				if (chunk) return controller.enqueue(chunk);
				if (drop) return controller.error(new TypeError('network error'));
				if (!hold) return controller.close();
				return new Promise<void>((_, reject) => {
					init?.signal?.addEventListener('abort', () => {
						controller.error(new DOMException('', 'AbortError'));
						reject(new DOMException('', 'AbortError'));
					});
				});
			}
		});
		return new Response(body);
	});
	return { fetch, calls };
}

beforeEach(() => {
	nav.goto.mockClear();
	nav.invalidateAll.mockClear();
	nav.page.params = {};
});

describe('CoachTurn.apply', () => {
	it('thinks until the first step or words, then shows chips, words a frame at a time and blocks', () => {
		const clock = frames();
		const turn = new CoachTurn(request(), { frame: clock.frame });
		expect(turn.thinking).toBe(true);

		turn.apply(started);
		expect(turn.thinking).toBe(true);
		expect(turn.threadId).toBe(THREAD);
		expect(turn.ownerMessageId).toBe(OWNER);

		turn.apply({
			type: 'activity',
			id: 't1',
			tool: 'get_exercise_history',
			state: 'running',
			label: 'Looking…'
		});
		expect(turn.thinking).toBe(false);
		turn.apply({
			type: 'activity',
			id: 't1',
			tool: 'get_exercise_history',
			state: 'done',
			label: 'Looked'
		});
		expect(turn.chips).toEqual([{ id: 't1', state: 'done', label: 'Looked' }]);

		turn.apply({ type: 'block_started', block: 0, kind: 'metric', method: 'Epley' });
		turn.apply({ type: 'text_delta', block: 0, text: 'Your top ' });
		turn.apply({ type: 'text_delta', block: 0, text: 'set went ' });
		// Two deltas in one frame: drawn once, when the frame comes.
		expect(clock.pending).toBe(1);
		expect(turn.drafts).toEqual([{ block: 0, kind: 'metric', text: '' }]);
		clock.run();
		expect(turn.drafts).toEqual([{ block: 0, kind: 'metric', text: 'Your top set went ' }]);
		turn.apply({ type: 'text_delta', block: 0, text: 'up.' });
		clock.run();
		expect(turn.drafts[0]!.text).toBe('Your top set went up.');

		turn.apply(completed(0));
		expect(turn.drafts).toEqual([]);
		expect(turn.blocks).toEqual([block(0)]);
		expect(turn.answered).toBe(false);
		turn.apply({ type: 'answer_completed', messageId: ANSWER });
		expect(turn.answered).toBe(true);
	});

	it('replaces a block the policy changed, and starts again on answer_reset', () => {
		const turn = new CoachTurn(request(), { frame: () => {} });
		turn.apply(completed(0));
		turn.apply(completed(1));
		turn.apply({ type: 'block_replaced', reason: 'safety', ...block(1, 'Stop and rest') });
		expect(turn.blocks).toEqual([block(0), block(1, 'Stop and rest')]);

		turn.apply({ type: 'block_started', block: 2, kind: 'note', method: null });
		turn.apply({ type: 'text_delta', block: 2, text: 'half' });
		turn.apply({ type: 'answer_reset', reason: 'fallback' });
		turn.flush();
		expect(turn.blocks).toEqual([]);
		expect(turn.drafts).toEqual([]);
	});

	it('draws a block’s waiting words before the next block starts', () => {
		const turn = new CoachTurn(request(), { frame: () => {} });
		turn.apply({ type: 'block_started', block: 0, kind: 'note', method: null });
		turn.apply({ type: 'text_delta', block: 0, text: 'First' });
		turn.apply({ type: 'block_started', block: 1, kind: 'note', method: null });
		expect(turn.drafts.map((d) => d.text)).toEqual(['First', '']);
	});
});

describe('CoachTurn.run', () => {
	it('an answer shown and stored ends the turn with nothing to read again', async () => {
		const { fetch, calls } = server(ANSWERED);
		const turn = new CoachTurn(request(), { fetch, frame: () => {} });
		const onStarted = vi.fn();
		expect(await turn.run(onStarted)).toBe(false);
		expect(onStarted).toHaveBeenCalledWith(THREAD);
		expect(turn.running).toBe(false);
		expect(turn.answered).toBe(true);
		expect(turn.status).toBe('completed');
		expect(turn.error).toBeNull();
		expect(calls.map((c) => c.url)).toEqual(['/api/coach/turns']);
	});

	it('a dropped stream waits for the run to finish, then asks for the stored message', async () => {
		const { fetch, calls } = server([started, completed(0)], { drop: true });
		const turn = new CoachTurn(request(), { fetch, frame: () => {} });
		expect(await turn.run()).toBe(true);
		expect(turn.error).toBe('interrupted');
		expect(turn.running).toBe(false);
		expect(calls.map((c) => c.url)).toEqual(['/api/coach/turns', '/api/coach/runs?limit=5']);
	});

	it('Stop flags the run before it drops the stream, and ends as Stopped', async () => {
		const { fetch, calls } = server([started], { hold: true });
		const turn = new CoachTurn(request(), { fetch, frame: () => {} });
		const ran = turn.run();
		await vi.waitFor(() => expect(turn.runId).toBe(RUN));
		await turn.stop();
		expect(await ran).toBe(true);
		expect(turn.error).toBe('cancelled');
		expect(calls.map((c) => c.url)).toEqual([
			'/api/coach/turns',
			`/api/coach/runs/${RUN}/cancel`,
			'/api/coach/runs?limit=5'
		]);
	});

	it('leaving drops the stream without flagging the run or reading anything', async () => {
		const { fetch, calls } = server([started], { hold: true });
		const turn = new CoachTurn(request(), { fetch, frame: () => {} });
		const ran = turn.run();
		await vi.waitFor(() => expect(turn.runId).toBe(RUN));
		turn.leave();
		expect(await ran).toBe(false);
		expect(calls.map((c) => c.url)).toEqual(['/api/coach/turns']);
	});

	it('a turn the endpoint refused shows why and reads nothing', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(() =>
			Promise.resolve(new Response('{}', { status: 429 }))
		);
		const turn = new CoachTurn(request(), { fetch, frame: () => {} });
		expect(await turn.run()).toBe(false);
		expect(turn.error).toBe('rate_limited');
	});
});

describe('CoachTurns', () => {
	it('a new conversation’s page opens as soon as the server names it', async () => {
		const { fetch } = server(ANSWERED);
		const turns = new CoachTurns({ fetch, frame: () => {} });
		await turns.send('How has my bench progressed this month?', 'workout');
		expect(nav.goto).toHaveBeenCalledWith(`/coach/${THREAD}`, { replace: true, reset: false });
		expect(nav.invalidateAll).not.toHaveBeenCalled();
		const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
		expect(body).toMatchObject({ threadId: null, entry: { from: 'workout', ref: null } });
		expect(turns.list[0]!.settled).toBe(true);
	});

	it('a turn in an open conversation that did not show its answer reads the stored messages', async () => {
		nav.page.params = { thread: THREAD };
		const { fetch } = server([started], { drop: true });
		const turns = new CoachTurns({ fetch, frame: () => {} });
		await turns.send('And my squat?', 'workout');
		expect(nav.goto).not.toHaveBeenCalled();
		expect(nav.invalidateAll).toHaveBeenCalledTimes(1);
		const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
		expect(body).toMatchObject({ threadId: THREAD, entry: null });
	});

	it('keeps a new conversation’s turn on /coach until its page has opened', async () => {
		let open!: () => void;
		nav.goto.mockImplementationOnce(() => new Promise<void>((done) => (open = done)));
		const { fetch } = server(ANSWERED);
		const turns = new CoachTurns({ fetch, frame: () => {} });
		expect(turns.asking).toBe(false);
		await turns.send('First');
		expect(turns.visible).toHaveLength(1);
		expect(turns.asking).toBe(true);
		open();
		await vi.waitFor(() => expect(turns.visible).toEqual([]));
		expect(turns.asking).toBe(false);
		nav.page.params = { thread: THREAD };
		expect(turns.visible).toHaveLength(1);
		expect(turns.asking).toBe(false);
	});

	it('forgets every turn when the page is left', async () => {
		const { fetch } = server([started], { hold: true });
		const turns = new CoachTurns({ fetch, frame: () => {} });
		const sent = turns.send('First');
		await vi.waitFor(() => expect(turns.list[0]?.runId).toBe(RUN));
		turns.leave();
		await sent;
		expect(turns.list).toEqual([]);
	});

	it('shows only the conversation on screen’s turns, and Retry sends the stored message’s id', async () => {
		const { fetch } = server(ANSWERED);
		const turns = new CoachTurns({ fetch, frame: () => {} });
		await turns.send('First');
		expect(turns.visible).toEqual([]); // on /coach, but the turn now belongs to its conversation
		nav.page.params = { thread: THREAD };
		expect(turns.visible).toHaveLength(1);

		await turns.retry({ clientMessageId: 'stored-id', text: 'First' }, THREAD);
		const body = JSON.parse(fetch.mock.calls[1]![1]!.body as string);
		expect(body).toEqual({ threadId: THREAD, clientMessageId: 'stored-id', text: 'First' });
		expect(turns.visible.map((t) => t.retry)).toEqual([false, true]);
		expect(turns.running).toBe(false);
	});
});
