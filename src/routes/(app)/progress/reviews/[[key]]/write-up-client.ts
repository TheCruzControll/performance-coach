/**
 * The write-up's browser half (CoachWriteUp loads it after hydration, so none of it is initial
 * JS): request the write-up once, on idle, for a review that has none; follow a run another
 * request started by polling; and load M5's AnswerBlocks to draw the run's display blocks.
 *
 * - POST /api/reviews/narrate {kind, id} runs the write-up. The server never ties the run to this
 *   request, so leaving the page does not cancel it: the next visit shows the stored result.
 * - busy (another tab or an earlier visit is writing it): GET at 2, 4 and 8 s, then every 8 s up
 *   to COACH_MAX_DURATION_S, then the stored result, or a failure with Retry.
 * - A request that fails, or is refused, is a notice (write-up.ts); the review is never touched.
 */
import {
	noticeOf,
	pollDelaysMs,
	viewOfPoll,
	viewOfReply,
	type NarrateReply,
	type NarrationPoll,
	type NarrationView,
	type WriteUpTarget
} from './write-up';

const ENDPOINT = '/api/reviews/narrate';

export interface FollowIo {
	/** The view moved on. */
	set: (view: NarrationView) => void;
	/** Aborted when the review leaves the page: no more requests. */
	signal: AbortSignal;
	fetch?: typeof fetch;
	wait?: (ms: number) => Promise<void>;
	idle?: () => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const idleness = () =>
	new Promise<void>((done) =>
		'requestIdleCallback' in window ? requestIdleCallback(() => done()) : setTimeout(done, 1)
	);

async function read<T>(response: Response): Promise<T | null> {
	return response.ok || response.status === 409 ? ((await response.json()) as T) : null;
}

/** Poll the run another request started until it is stored, it ends, or the time is up. */
async function poll(target: WriteUpTarget, io: FollowIo) {
	const query = new URLSearchParams({ kind: target.kind, id: target.id });
	for (const ms of pollDelaysMs()) {
		await (io.wait ?? sleep)(ms);
		if (io.signal.aborted) return;
		const state = await (io.fetch ?? fetch)(`${ENDPOINT}?${query}`, { signal: io.signal })
			.then((response) => read<NarrationPoll>(response))
			.catch(() => null);
		if (io.signal.aborted) return;
		if (state && state.state !== 'running') return io.set(viewOfPoll(state));
	}
	io.set(noticeOf('failed'));
}

/** Ask for the write-up now (first opening, or Retry), then follow it. */
export async function request(target: WriteUpTarget, io: FollowIo): Promise<void> {
	io.set({ state: 'writing', ask: false });
	const reply = await (io.fetch ?? fetch)(ENDPOINT, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(target)
	})
		.then((response) => read<NarrateReply>(response))
		.catch(() => null);
	if (io.signal.aborted) return;
	const view = reply ? viewOfReply(reply) : noticeOf(navigator.onLine ? 'failed' : 'offline');
	io.set(view);
	if (view.state === 'writing') await poll(target, io);
}

/** Take the view the server rendered on: request it on idle, or poll a run already going. */
export async function follow(
	target: WriteUpTarget,
	view: NarrationView,
	io: FollowIo
): Promise<void> {
	if (view.state !== 'writing') return;
	if (!view.ask) return poll(target, io);
	await (io.idle ?? idleness)();
	if (!io.signal.aborted) await request(target, io);
}

/** M5's answer blocks, loaded only once a write-up is there to draw. */
export const answerBlocks = () => import('#lib/ui/coach/AnswerBlocks.svelte');
