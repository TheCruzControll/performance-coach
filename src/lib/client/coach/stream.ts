/**
 * The coach's stream client (M5 plan, Streaming and cancellation). Loaded by a dynamic import()
 * with turn.svelte.ts, on the composer's focus or on idle, never in a screen's initial JavaScript.
 *
 * - streamTurn POSTs one turn to /api/coach/turns and reads its server-sent events with fetch
 *   (EventSource cannot POST) through the domain's decoder, so the browser parses no JSON but the
 *   events' own and no markdown at all. It resolves with how the stream ended.
 * - cancelRun is Stop's flag on the run (POST /api/coach/runs/[run]/cancel); the caller then drops
 *   the stream, and the server stores what was shown as 'Stopped'.
 * - settleRun is the way back after a dropped stream: it waits until the run has finished on the
 *   server, so the stored final (or interrupted) message is there to be read.
 */
import { createSseDecoder, type CoachEvent } from '#lib/domain/coach/events.ts';
import type { CoachErrorKind, RunStatus } from '#lib/domain/coach/vocabulary.ts';

/** What a turn is about, as a source ref (`proposal:<id>`). */
export interface TurnRef {
	type: string;
	id: string;
	label?: string;
}

export interface TurnRequest {
	/** The conversation to continue; null starts a new one. */
	threadId: string | null;
	/** The device's id for the message: sending it again (Retry) stores nothing new. */
	clientMessageId: string;
	text: string;
	/**
	 * Where a new conversation was started from (an entry point's `from`), or what a turn is about
	 * ('Ask for changes' names the proposal).
	 */
	entry?: { from: string; ref: TurnRef | null } | null;
}

/** How a turn's stream ended. */
export type StreamEnd =
	/** The stream ended with `done`. */
	| { kind: 'done'; status: RunStatus | null }
	/** The endpoint answered without a stream: 429, 400 or another error. */
	| { kind: 'refused'; error: CoachErrorKind; retryAfterS?: number }
	/** The caller's signal: Stop, or the page was left. */
	| { kind: 'aborted' }
	/** The connection failed or closed before `done`. */
	| { kind: 'dropped' };

type Fetch = typeof globalThis.fetch;

function refusal(response: Response): StreamEnd {
	if (response.status === 429) {
		const after = Number(response.headers.get('retry-after'));
		return {
			kind: 'refused',
			error: 'rate_limited',
			...(Number.isFinite(after) && after > 0 ? { retryAfterS: after } : {})
		};
	}
	return { kind: 'refused', error: response.status === 400 ? 'invalid_request' : 'provider' };
}

/** Send one turn and hand each event to `onEvent`, in order, as it arrives. */
export async function streamTurn(
	request: TurnRequest,
	onEvent: (event: CoachEvent) => void,
	{ signal, fetch = globalThis.fetch }: { signal: AbortSignal; fetch?: Fetch }
): Promise<StreamEnd> {
	let finished: StreamEnd | null = null;
	const take = (events: CoachEvent[]) => {
		for (const event of events) {
			onEvent(event);
			if (event.type === 'done') finished = { kind: 'done', status: event.status };
		}
	};
	try {
		const response = await fetch('/api/coach/turns', {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
			body: JSON.stringify(request),
			signal
		});
		if (response.status !== 200 || !response.body) return refusal(response);
		const decoder = createSseDecoder();
		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			take(decoder.push(value));
		}
		take(decoder.end());
	} catch {
		// A failed fetch, a broken stream or a frame the decoder refused: what arrived stands.
	}
	return finished ?? (signal.aborted ? { kind: 'aborted' } : { kind: 'dropped' });
}

/** Stop: flag the run, which the turn reads between steps. A failure leaves the drop to stop it. */
export async function cancelRun(runId: string, fetch: Fetch = globalThis.fetch): Promise<void> {
	await fetch(`/api/coach/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }).catch(
		() => undefined
	);
}

/**
 * Decision: how long the screen waits for a dropped turn to finish on the server before it shows
 * what is stored, and how often it asks. A turn whose stream is dropped stops at its next step
 * and stores what was shown, well within this. Once a second keeps one settle to 11 reads of
 * the usage list, which shares the 60-a-minute 'coach.action' limit with Accept and Reject.
 */
export const SETTLE = Object.freeze({ waitMs: 10_000, everyMs: 1_000 });

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Wait until run `runId` (or, unknown, the newest run) is no longer running, reading the usage
 * list (GET /api/coach/runs). True once it has finished; false when it still runs after
 * SETTLE.waitMs or the list cannot be read, and the screen shows what is stored anyway.
 */
export async function settleRun(
	runId: string | null,
	{
		fetch = globalThis.fetch,
		sleep = pause,
		waitMs = SETTLE.waitMs,
		everyMs = SETTLE.everyMs
	}: {
		fetch?: Fetch;
		sleep?: (ms: number) => Promise<void>;
		waitMs?: number;
		everyMs?: number;
	} = {}
): Promise<boolean> {
	for (let waited = 0; ; waited += everyMs) {
		try {
			const response = await fetch('/api/coach/runs?limit=5');
			if (!response.ok) return false;
			const { runs } = (await response.json()) as { runs: { id: string; status: string }[] };
			const run = runId === null ? runs[0] : runs.find((each) => each.id === runId);
			if (run?.status !== 'running') return true;
		} catch {
			return false;
		}
		if (waited >= waitMs) return false;
		await sleep(everyMs);
	}
}
