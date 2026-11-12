/**
 * The sync engine (the offline workout sync ADR: 'Bounded flushing', 'Tabs', 'Losing the session'):
 * it delivers the outbox to POST /api/workouts/sync exactly once and in order. It loads on idle,
 * after first render, never in the hydration path; one engine per page (workout-sync-wiring).
 *
 * - One flusher per device: each round runs under the Web Lock 'pc-workout-sync'. Without the API
 *   every tab flushes, and the server's ledger answers the second copy 'duplicate'.
 * - Batches come from outbox-rules' nextBatch: strict FIFO within the caps, a parked or waiting
 *   entry holding only its dependants. A change too large to send even alone is parked as refused.
 * - Every request is bounded: aborted after 15 s on the engine's own timer (an AbortController,
 *   never AbortSignal.timeout, so tests control it), and the lock is released at once, so a hung
 *   request never holds the flusher. Only this server's answers count towards 'Needs attention':
 *   its JSON 5xx or other refusal of the batch is counted against the entry that heads it. A
 *   timeout, a network failure or a page that is not its JSON (a captive portal, dead gym Wi-Fi,
 *   where iOS still says online) is unreachable: nothing is counted, the 24 hours pause as they
 *   do offline, and the status reads 'Can’t connect · N waiting' until the server answers. Both
 *   back off with full jitter.
 * - An answer is applied by store.acknowledge in one IndexedDB transaction, the canonical rows
 *   stored with it, so the view re-projects; 'retry' and 'deferred' answers are counted there.
 *   A request names the workouts whose rows the device holds (store.held), so their answers carry
 *   only the rows that changed (domain/workout/changes.ts), which acknowledge folds in.
 * - Triggers: app start (startSync), 'online' and becoming visible (both at once, even mid-backoff;
 *   'online' also resets the backoff and ends every entry's wait), the backoff timer, flush(), which
 *   waits out a backoff, and soon(), which workout-sync-wiring calls on every saved change: a
 *   round at once after a quiet spell, while changes within COALESCE_MS of a round's start go
 *   together in one round when that window ends, or at once when the page is hidden.
 * - Ids the owner discarded (store.discarded) go first with every request, the pagehide one too,
 *   until an answer shows the server has claimed them (store.forget), alone if nothing else is
 *   sendable: a request this engine stopped waiting for then answers 'duplicate' for them, and can
 *   never land a discarded change after a newer one (finding F1 of the workout sync model). More
 *   than a request holds go alone, 25 at a time, before any change is sent (gone).
 * - On pagehide the head of the outbox goes with fetch keepalive, at most 48 KB, so RUM's
 *   sendBeacon still fits the page's 64 KB keepalive quota. Its answer is not awaited: the next
 *   flush resends those changes, and the ledger answers 'duplicate'.
 * - Offline (navigator.onLine false) nothing is sent and nothing is counted. A request cancelled
 *   because the page is being left (leaving.ts) is not a failure either, and no round starts
 *   while it is being left: the keepalive send is that moment's.
 * - 401 (signed out elsewhere, revoked from Security, expired): store.purgeServerCopies, the status
 *   'Sign in to sync · N waiting', and this engine sends nothing more; reconcile's 401 likewise
 *   (signedOut). The store keeps the device signed out, so a later engine shows that status while
 *   anything waits, until the server answers as the owner (signedIn). 403 passkey_required (a
 *   recovery session): 'Finish adding your passkey to sync', everything kept, and likewise nothing
 *   more sent. Any other 403 backs off like a 5xx. A new session needs a new engine, and sign-in and
 *   recovery navigate on the client (goto), so whoever starts one stops it when it unmounts and
 *   starts another when it mounts again (workout-sync-wiring).
 * Plain .ts with no runes: the clock, the timers, the lock, the network and the page's events are
 * all injected.
 */
import { isLeaving } from '../leaving.ts';
import { SYNC_LIMITS } from '#lib/domain/workout/index.ts';
import type { SyncResponse, SyncResult } from '#lib/domain/workout/index.ts';
import { BATCH_CAPS, nextBatch, nextDelay, syncStatus } from './outbox-rules.ts';
import type { OutboxEntry, OutboxStatus, SyncSession } from './outbox-rules.ts';
import type { WorkoutStore } from './store.ts';

export const SYNC_URL = '/api/workouts/sync';
/** One flusher per device: the Web Lock every tab's engine asks for before a round. */
export const SYNC_LOCK = 'pc-workout-sync';
/** A sync POST without its answer after this long is aborted: the server is out of reach. */
export const REQUEST_TIMEOUT_MS = 15_000;
/**
 * A saved change within this long of a round's start waits for the window to end, so a burst of
 * changes (a set, its rest timer, the store's own notices of them) goes in one round.
 */
export const COALESCE_MS = 250;

export type SyncStore = Pick<
	WorkoutStore,
	| 'closed'
	| 'outbox'
	| 'acknowledge'
	| 'held'
	| 'countFailure'
	| 'backOnline'
	| 'purgeServerCopies'
	| 'discarded'
	| 'forget'
	| 'signedOut'
	| 'signedIn'
>;

/** navigator.locks, as far as the engine uses it. */
export interface SyncLocks {
	request(name: string, callback: () => Promise<void>): Promise<void>;
}

type Events = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/** The window ('online', 'offline', 'pagehide') and the document ('visibilitychange'). */
export interface SyncPage {
	window: Events;
	document: Events & { readonly visibilityState: DocumentVisibilityState };
}

export interface SyncOptions {
	store: SyncStore;
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	/** navigator.locks by default; null where the API is missing. */
	locks?: SyncLocks | null;
	/** Epoch ms on this device. */
	now?: () => number;
	random?: () => number;
	setTimeout?: (run: () => void, ms: number) => unknown;
	clearTimeout?: (timer: unknown) => void;
	/** navigator.onLine by default. */
	online?: () => boolean;
	/** The page whose events trigger a flush; none outside a browser. */
	events?: SyncPage | null;
	/** Whether the page is being left (leaving.ts). */
	leaving?: () => boolean;
}

export interface SyncEngine {
	/** Sends what can be sent; resolves when this round, and any asked for during it, has ended. */
	flush(): Promise<void>;
	/**
	 * A change was saved: a round at once after a quiet spell, else one round when COALESCE_MS from
	 * the last round's start has passed (at once if the page is hidden first).
	 */
	soon(): void;
	/** The status the screens show at `at` (now by default); null until the outbox is read. */
	status(at?: number): OutboxStatus | null;
	/** Called whenever the status may have changed. */
	onChange(listener: () => void): () => void;
	/**
	 * No more rounds, timers or listeners. A request on its way is still applied. Call it when the
	 * component that started the engine unmounts: after a lost session an engine never sends again.
	 */
	stop(): void;
	/** Another of the owner's requests (reconcile's GET) answered 401: as one of the engine's. */
	signedOut(): Promise<void>;
	/**
	 * Another of the owner's requests answered as the owner: the session is back. Not after a 401 on
	 * this engine, which is final: that answer is to a request sent before it.
	 */
	signedIn(): Promise<void>;
	/** A 401 on this engine: what it purged is never restored on this page. */
	signedOutHere(): boolean;
}

/** How a request ended. */
type Outcome =
	| { kind: 'answered'; results: SyncResult[] }
	/** This server refused the batch (its JSON 5xx, a result list that is not the batch's): counted. */
	| { kind: 'failed'; error: string }
	/** No answer from this server: a timeout, a network failure, a page that is not its JSON. */
	| { kind: 'unreachable' }
	| { kind: 'session'; session: Exclude<SyncSession, 'active'> }
	/** Cancelled because the page is being left: nothing is counted. */
	| { kind: 'left' };

const HEADERS = { 'content-type': 'application/json', accept: 'application/json' };
/**
 * The discarded ids a request carries, and whether a change may go with them: only once every id
 * fits, or a change could land before a discarded one the request left out.
 */
function gone(discarded: readonly string[]) {
	return {
		ids: discarded.slice(0, SYNC_LIMITS.maxMutations),
		send: discarded.length <= SYNC_LIMITS.maxMutations
	};
}

const bodyOf = (
	entries: readonly OutboxEntry[],
	discarded: readonly string[],
	held: readonly string[] = []
) =>
	JSON.stringify({
		v: 1,
		mutations: entries.map((e) => e.envelope),
		...(discarded.length > 0 && { discarded }),
		...(held.length > 0 && { held })
	});

/** Refused for good, so the owner sees it and can discard it, instead of it waiting unseen. */
const tooLarge = (entry: OutboxEntry): SyncResult => ({
	id: entry.envelope.id,
	status: 'rejected',
	code: 'invalid',
	errors: { payload: 'Too large to sync' }
});

/**
 * One result per mutation in request order (the protocol), fewer only where the server stopped the
 * batch. Anything else would acknowledge nothing and resend the same batch at once, again and again.
 */
function answers(batch: readonly OutboxEntry[], results: unknown): results is SyncResult[] {
	return (
		Array.isArray(results) &&
		(results.length > 0 || batch.length === 0) &&
		results.length <= batch.length &&
		results.every((r: Partial<SyncResult> | null, i) => r?.id === batch[i]!.envelope.id)
	);
}

export function startSync({
	store,
	fetch: request = (url, init) => fetch(url, init),
	locks = globalThis.navigator?.locks ?? null,
	now = Date.now,
	random = Math.random,
	setTimeout: later = (run, ms) => setTimeout(run, ms),
	clearTimeout: cancel = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
	online = () => globalThis.navigator?.onLine ?? true,
	events = typeof window === 'undefined' ? null : { window, document },
	leaving = isLeaving
}: SyncOptions): SyncEngine {
	const listeners = new Set<() => void>();
	const changed = () => listeners.forEach((listener) => listener());
	/** The outbox at the last read: the status, and the pagehide batch, which cannot wait. */
	let entries: readonly OutboxEntry[] | null = null;
	/** The discarded ids at the last read: sent first with every request until the server has them. */
	let discarded: readonly string[] = [];
	let reads = 0;
	let session: SyncSession = 'active';
	/** A 401 purged the device, on this page or before it (store.signedOut): the pages hide it. */
	let suspended = false;
	let inFlight = false;
	let stopped = false;
	/** The engine's own backoff after a failed batch: failures in a row, and when it sends again. */
	let attempt = 0;
	let retryAt: number | null = null;
	/** Since when the device has been offline; null while online. */
	let offlineSince: number | null = null;
	/** Since when, online, the server has not answered (a request went unanswered); null once it does. */
	let unreachableSince: number | null = null;
	let timer: unknown = null;
	let running: Promise<void> | null = null;
	let again = false;
	/** When the last round started, and the timer of the round soon() put off until COALESCE_MS. */
	let startedAt = -Infinity;
	let coalesced: unknown = null;
	/** Workouts an answer applied changes of but brought no rows for: asked for whole until they come. */
	const unheld = new Set<string>();

	/** The outbox, then the discarded ids: a change read here was made after any discard it saw. */
	async function read() {
		const n = ++reads;
		const outbox = await store.outbox();
		const ids = await store.discarded();
		const purged = await store.signedOut();
		if (n === reads) {
			entries = outbox;
			discarded = ids;
			suspended = purged;
			changed();
		}
		return { outbox, ids };
	}

	async function post(
		batch: readonly OutboxEntry[],
		ids: readonly string[],
		held: readonly string[]
	): Promise<Outcome> {
		const controller = new AbortController();
		const timeout = later(() => controller.abort(), REQUEST_TIMEOUT_MS);
		inFlight = true;
		changed();
		try {
			const response = await request(SYNC_URL, {
				method: 'POST',
				headers: HEADERS,
				body: bodyOf(batch, ids, held),
				signal: controller.signal
			});
			if (response.status === 401) return { kind: 'session', session: 'signed-out' };
			// Every answer of this server is JSON: a portal's or a gateway's page throws here.
			const body = (await response.json()) as (Partial<SyncResponse> & { error?: unknown }) | null;
			if (response.status === 403 && body?.error === 'passkey_required') {
				return { kind: 'session', session: 'passkey-required' };
			}
			if (!response.ok) return { kind: 'failed', error: `The server answered ${response.status}` };
			const results = body?.results;
			if (!answers(batch, results)) {
				return { kind: 'failed', error: 'The server answered nonsense' };
			}
			return { kind: 'answered', results };
		} catch {
			return leaving() ? { kind: 'left' } : { kind: 'unreachable' };
		} finally {
			cancel(timeout);
			inFlight = false;
			changed();
		}
	}

	/** A 401: what the server holds is deleted, and this engine sends nothing more. */
	async function signedOut(): Promise<void> {
		session = 'signed-out';
		suspended = true;
		await store.purgeServerCopies();
		changed();
	}

	async function signedIn(): Promise<void> {
		if (session === 'signed-out') return;
		suspended = false;
		await store.signedIn();
		changed();
	}

	/**
	 * An answer that applied a workout's changes without its rows (the server could not read them)
	 * leaves the device's rows short of them: the next request asks for that workout whole.
	 */
	function rowless(sent: readonly OutboxEntry[], results: readonly SyncResult[]): void {
		const workoutOf = new Map(sent.map((e) => [e.envelope.id, e.envelope.workoutId]));
		const short = new Set<string>();
		for (const r of results) {
			const w = workoutOf.get(r.id);
			if (w && (r.status === 'applied' || r.status === 'duplicate')) short.add(w);
		}
		for (const r of results) {
			const rows = r.canonical ?? r.changes;
			if (rows) short.delete(rows.workout.id);
			if (r.canonical) unheld.delete(r.canonical.workout.id);
		}
		for (const w of short) unheld.add(w);
	}

	/**
	 * The server answered after it could not be reached: that stretch comes off each failing entry's
	 * 24 hours, as offline time does (store.backOnline), before its answer is applied.
	 */
	async function reached(): Promise<void> {
		if (unreachableSince === null) return;
		await store.backOnline(unreachableSince);
		unreachableSince = null;
	}

	/** Under the lock: batch after batch, until nothing is sendable, a failure, or a lost session. */
	async function drain(): Promise<void> {
		while (!stopped && session === 'active' && online() && !leaving()) {
			const { outbox, ids } = await read();
			const batch = nextBatch(outbox, now(), BATCH_CAPS.flush);
			if (batch.tooLarge.length > 0) {
				await store.acknowledge(batch.tooLarge.map(tooLarge));
				continue;
			}
			const voids = gone(ids);
			const sent = voids.send ? batch.entries : [];
			if (sent.length === 0 && voids.ids.length === 0) return;
			const workouts = [...new Set(sent.map((e) => e.envelope.workoutId))];
			const holds = workouts.length > 0 ? await store.held(workouts) : [];
			const held = holds.filter((w) => !unheld.has(w));
			const sentAt = now();
			const outcome = await post(sent, voids.ids, held);
			if (outcome.kind === 'answered' || outcome.kind === 'failed') await reached();
			switch (outcome.kind) {
				case 'answered': {
					attempt = 0;
					if (suspended) await signedIn();
					// A 401 (a reconcile's) came first: this answer restores nothing the purge deleted.
					if (session !== 'active') return;
					await store.acknowledge(outcome.results);
					rowless(sent, outcome.results);
					if (voids.ids.length > 0) await store.forget(voids.ids);
					// The server stopped the batch (a 'retry'): the waits it set wake the next round.
					const halted = outcome.results.some((r) => r.status === 'retry');
					if (halted || outcome.results.length < sent.length) return;
					break;
				}
				case 'failed':
					if (sent[0]) await store.countFailure(sent[0].seq, outcome.error);
					retryAt = now() + nextDelay(attempt++, random);
					return;
				case 'unreachable':
					unreachableSince ??= sentAt;
					retryAt = now() + nextDelay(attempt++, random);
					return;
				case 'session':
					if (outcome.session === 'signed-out') return signedOut();
					session = outcome.session;
					return;
				case 'left':
					return;
			}
		}
	}

	async function round(): Promise<void> {
		await read();
		if (!online()) {
			offlineSince ??= now();
			return;
		}
		if (session !== 'active') return;
		if (offlineSince !== null) {
			// Out of reach before it went offline: the whole stretch pauses the 24 hours, once.
			await store.backOnline(Math.min(offlineSince, unreachableSince ?? offlineSince));
			offlineSince = null;
			unreachableSince = null;
			attempt = 0;
			retryAt = null;
		}
		if (retryAt !== null && now() < retryAt) return;
		retryAt = null;
		await (locks ? locks.request(SYNC_LOCK, drain) : drain());
		await read();
	}

	/** One timer: the engine's backoff, or else the soonest wait an entry has. */
	function schedule(): void {
		if (timer !== null) cancel(timer);
		timer = null;
		if (stopped || session !== 'active' || !online()) return;
		const at = now();
		const waits = (entries ?? []).flatMap((e) =>
			!e.parked && e.nextAt !== null && e.nextAt > at ? [e.nextAt] : []
		);
		const wake = retryAt ?? (waits.length > 0 ? Math.min(...waits) : null);
		if (wake === null) return;
		timer = later(
			() => {
				timer = null;
				void flush();
			},
			Math.max(0, wake - at)
		);
	}

	function flush(): Promise<void> {
		if (stopped) return Promise.resolve();
		if (running) {
			again = true;
			void read().catch(() => {}); // keeps the pagehide batch current while a round is out
			return running;
		}
		running = (async () => {
			try {
				do {
					again = false;
					startedAt = now();
					await round();
				} while (again && !stopped);
			} catch (error) {
				// Sign-out deleted the database, or a newer app upgraded it: nothing left to send.
				if (!store.closed) {
					// Anything else (a transient IndexedDB error): reported, and the backoff timer retries.
					retryAt = now() + nextDelay(attempt++, random);
					throw error;
				}
				stop();
			} finally {
				running = null;
				schedule();
				changed();
			}
		})();
		return running;
	}

	function soon(): void {
		if (stopped) return;
		const wait = startedAt + COALESCE_MS - now();
		if (wait <= 0 && coalesced === null) {
			flush().catch(() => {}); // a failed round is retried on the backoff timer
			return;
		}
		void read().catch(() => {}); // keeps the pagehide batch current while the round waits
		coalesced ??= later(() => {
			coalesced = null;
			flush().catch(() => {});
		}, wait);
	}

	/** The round soon() put off, at once: the page is being hidden, and may not run timers. */
	function hurry(): void {
		if (coalesced === null) return;
		cancel(coalesced);
		coalesced = null;
		flush().catch(() => {});
	}

	/** 'online' and becoming visible: a round at once, even mid-backoff. */
	function kick(): void {
		retryAt = null;
		void flush();
	}

	function keepalive(): void {
		if (stopped || session !== 'active' || !online() || !entries) return;
		const voids = gone(discarded);
		const batch = voids.send ? nextBatch(entries, now(), BATCH_CAPS.keepalive).entries : [];
		if (batch.length === 0 && voids.ids.length === 0) return;
		const body = bodyOf(batch, voids.ids);
		const init = { method: 'POST', headers: HEADERS, body, keepalive: true };
		void request(SYNC_URL, init).catch(() => {});
	}

	const onOnline = () => {
		offlineSince ??= now();
		kick();
	};
	const onOffline = () => {
		offlineSince ??= now();
		schedule();
		changed();
	};
	const onVisibility = () => {
		if (events?.document.visibilityState === 'visible') kick();
		else hurry();
	};

	function stop(): void {
		stopped = true;
		if (timer !== null) cancel(timer);
		timer = null;
		if (coalesced !== null) cancel(coalesced);
		coalesced = null;
		events?.window.removeEventListener('online', onOnline);
		events?.window.removeEventListener('offline', onOffline);
		events?.window.removeEventListener('pagehide', keepalive);
		events?.document.removeEventListener('visibilitychange', onVisibility);
	}

	events?.window.addEventListener('online', onOnline);
	events?.window.addEventListener('offline', onOffline);
	events?.window.addEventListener('pagehide', keepalive);
	events?.document.addEventListener('visibilitychange', onVisibility);
	void flush(); // app start

	return {
		flush,
		soon,
		status(at = now()) {
			if (!entries) return null;
			// Signed out on an earlier page: shown so until the server answers, if anything is kept.
			const lost = session === 'active' && suspended && entries.length > 0 ? 'signed-out' : session;
			return syncStatus(entries, {
				online: online(),
				unreachable: unreachableSince !== null,
				inFlight,
				session: lost,
				now: at,
				retryAt
			});
		},
		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		stop,
		signedOut,
		signedIn,
		signedOutHere: () => session === 'signed-out'
	};
}
