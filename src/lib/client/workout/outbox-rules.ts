/**
 * The outbox's rules (the offline workout sync ADR, 'Bounded flushing'): what the sync engine sends
 * next, how each answer changes an entry, the retry delay, when a change that keeps failing is
 * shown to the owner, what Discard removes, and the status the screens show.
 *
 * Pure and deterministic: the clock (`now`, epoch ms on this device) and the randomness are
 * arguments, and every function returns new entries, never changing the ones it is given. Plain
 * .ts with no runes, so Vitest's unit project runs it.
 */
import { dependsOn, SYNC_CODE_LABEL, SYNC_LIMITS } from '#lib/domain/workout/index.ts';
import type { Mutation, SyncCode, SyncResult } from '#lib/domain/workout/index.ts';
import type { FieldErrors } from '#lib/domain/validation.ts';

/**
 * When a change that keeps failing is parked as 'Needs attention', with Try again and Discard: at
 * 50 counted failures, or 24 hours after the first of them, less any time spent offline. The
 * numbers are the owner's to change (the M4 plan's open question 26).
 */
export const STUCK_AFTER = { failures: 50, ms: 24 * 60 * 60 * 1000 };

/** Full-jitter backoff: a wait drawn evenly from 0 to min(maxMs, baseMs × 2^attempt). */
export const BACKOFF = { baseMs: 1000, maxMs: 60 * 1000 };

export interface BatchCaps {
	maxCount: number;
	maxBytes: number;
}

/** A flush's batch, and the pagehide keepalive send's, which leaves RUM's sendBeacon 16 KB. */
export const BATCH_CAPS = {
	flush: { maxCount: SYNC_LIMITS.maxMutations, maxBytes: SYNC_LIMITS.maxBytes },
	keepalive: { maxCount: SYNC_LIMITS.maxMutations, maxBytes: SYNC_LIMITS.keepaliveBytes }
} satisfies Record<string, BatchCaps>;

/** Held for the owner: 'Needs attention'. */
export interface Parked {
	/** refused: rejected by the server, for Fix or Discard; stuck: it kept failing (STUCK_AFTER). */
	reason: 'refused' | 'stuck';
	/** A refusal's field errors at dotted paths under `payload.`; none when stuck. */
	errors: FieldErrors;
	/** The refusal's reason in words, or the last error before it was parked. */
	message: string;
}

export interface OutboxEntry {
	/** The outbox's autoIncrement key: the order changes are sent in. */
	seq: number;
	envelope: Mutation;
	/** Counted failures: a 'retry' or 'deferred' answer, or a 5xx or timeout of a batch it heads. */
	attempts: number;
	/** When the first counted failure happened, moved on by any time spent offline since. */
	failingSince: number | null;
	/** Not sent before this time: its backoff after a 'retry' or 'deferred' answer. */
	nextAt: number | null;
	parked?: Parked;
}

/** A change as it enters the outbox, or re-enters it in its place (Try again, Fix). */
export function queued(seq: number, envelope: Mutation): OutboxEntry {
	return { seq, envelope, attempts: 0, failingSince: null, nextAt: null };
}

const inOrder = (entries: readonly OutboxEntry[]) => [...entries].sort((a, b) => a.seq - b.seq);
const isWaiting = (entry: OutboxEntry, now: number) => entry.nextAt !== null && entry.nextAt > now;

const encoder = new TextEncoder();
const bytesOf = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
/**
 * The request body around the mutations, in UTF-8 bytes: `{"v":1,"mutations":[…]}` with the largest
 * `discarded` and `held` lists the server takes (25 ids each), so neither can push it over a cap.
 */
const MOST_IDS = Array<string>(SYNC_LIMITS.maxMutations).fill(
	'00000000-0000-0000-0000-000000000000'
);
const EMPTY_BODY = bytesOf({ v: 1, mutations: [], discarded: MOST_IDS, held: MOST_IDS });

export interface Batch {
	entries: OutboxEntry[];
	/**
	 * Changes too large to send even alone. After a flush the engine parks them as refused (a
	 * 'rejected' result through applyResults), so none waits unseen; after the keepalive send it
	 * leaves them to the next flush, whose cap is larger.
	 */
	tooLarge: OutboxEntry[];
}

/**
 * The next request's changes: strict FIFO by seq, within the caps. An entry parked, waiting for its
 * nextAt or too large is held, and so is every later entry that depends on a held one (its row,
 * its workout, a custom exercise it names): nothing overtakes a change it depends on, and nothing
 * else waits for it.
 */
export function nextBatch(entries: readonly OutboxEntry[], now: number, caps: BatchCaps): Batch {
	const batch: OutboxEntry[] = [];
	const tooLarge: OutboxEntry[] = [];
	const held: Mutation[] = [];
	let bytes = EMPTY_BODY;
	for (const entry of inOrder(entries)) {
		const m = entry.envelope;
		if (entry.parked || isWaiting(entry, now) || held.some((h) => dependsOn(m, h))) {
			held.push(m);
			continue;
		}
		const size = bytesOf(m);
		if (EMPTY_BODY + size > caps.maxBytes) {
			tooLarge.push(entry);
			held.push(m);
			continue;
		}
		const added = batch.length === 0 ? size : size + 1; // the comma between two mutations
		if (batch.length === caps.maxCount || bytes + added > caps.maxBytes) break;
		batch.push(entry);
		bytes += added;
	}
	return { entries: batch, tooLarge };
}

/**
 * The full-jitter wait before a retry, in ms: random() × min(60 s, 1 s × 2^attempt), where attempt
 * counts the failures before this one (0 for the first).
 */
export function nextDelay(attempt: number, random: () => number): number {
	return random() * Math.min(BACKOFF.maxMs, BACKOFF.baseMs * 2 ** attempt);
}

/** One more counted failure: at the cap the entry is parked as stuck, with this error. */
function fail(entry: OutboxEntry, error: string, now: number): OutboxEntry {
	const attempts = entry.attempts + 1;
	const failingSince = entry.failingSince ?? now;
	if (attempts < STUCK_AFTER.failures && now - failingSince < STUCK_AFTER.ms) {
		return { ...entry, attempts, failingSince };
	}
	const parked: Parked = { reason: 'stuck', errors: {}, message: error };
	return { ...entry, attempts, failingSince, nextAt: null, parked };
}

const label = (code: SyncCode | undefined, fallback: SyncCode) => SYNC_CODE_LABEL[code ?? fallback];

/**
 * A sync response: applied and duplicate leave the outbox; rejected is parked as refused with its
 * field errors; deferred and retry keep their place, count a failure and back off. An entry with no
 * result (the batch stopped at a retry) is unchanged.
 */
export function applyResults(
	entries: readonly OutboxEntry[],
	results: readonly SyncResult[],
	now: number,
	random: () => number
): OutboxEntry[] {
	const byId = new Map(results.map((r) => [r.id, r]));
	return entries.flatMap((entry): OutboxEntry[] => {
		const result = byId.get(entry.envelope.id);
		if (!result) return [entry];
		switch (result.status) {
			case 'applied':
			case 'duplicate':
				return [];
			case 'rejected': {
				const message = label(result.code, 'invalid');
				const parked: Parked = { reason: 'refused', errors: result.errors ?? {}, message };
				return [{ ...entry, nextAt: null, parked }];
			}
			case 'deferred':
			case 'retry': {
				const fallback = result.status === 'deferred' ? 'missing' : 'unavailable';
				const failed = fail(entry, label(result.code, fallback), now);
				if (failed.parked) return [failed];
				return [{ ...failed, nextAt: now + nextDelay(entry.attempts, random) }];
			}
		}
	});
}

/**
 * A 5xx or a timeout of a batch this entry heads, in words ('The server answered 500'): counted
 * against it alone. Its wait is the engine's own backoff, so nextAt is unchanged.
 */
export function countFailure(
	entries: readonly OutboxEntry[],
	seq: number,
	error: string,
	now: number
): OutboxEntry[] {
	return entries.map((e) => (e.seq === seq && !e.parked ? fail(e, error, now) : e));
}

/**
 * Back online after being offline since `offlineSince`: every wait ends at once, and the time spent
 * offline is taken off each failing entry's 24 hours, since an offline device counts no failure.
 */
export function backOnline(
	entries: readonly OutboxEntry[],
	offlineSince: number,
	now: number
): OutboxEntry[] {
	const offline = Math.max(0, now - offlineSince);
	return entries.map((e) => {
		if (e.parked) return e;
		const failingSince = e.failingSince === null ? null : Math.min(now, e.failingSince + offline);
		return { ...e, failingSince, nextAt: null };
	});
}

/** The later entries that depend on this one, directly or through another of them, in order. */
export function dependantsOf(entries: readonly OutboxEntry[], seq: number): OutboxEntry[] {
	const ordered = inOrder(entries);
	const root = ordered.find((e) => e.seq === seq);
	if (!root) return [];
	const gone = [root.envelope];
	const found: OutboxEntry[] = [];
	for (const entry of ordered) {
		if (entry.seq <= seq || !gone.some((g) => dependsOn(entry.envelope, g))) continue;
		gone.push(entry.envelope);
		found.push(entry);
	}
	return found;
}

/** Discard: the entry and everything that depends on it leave the outbox. */
export function discard(entries: readonly OutboxEntry[], seq: number): OutboxEntry[] {
	const gone = new Set([seq, ...dependantsOf(entries, seq).map((e) => e.seq)]);
	return entries.filter((e) => !gone.has(e.seq));
}

/** Try again: a stuck entry is queued again in its place, its count cleared. A refusal needs Fix. */
export function tryAgain(entries: readonly OutboxEntry[], seq: number): OutboxEntry[] {
	return entries.map((e) =>
		e.seq === seq && e.parked?.reason === 'stuck' ? queued(e.seq, e.envelope) : e
	);
}

/**
 * Fix: the corrected change replaces the entry in its place under the same id, which no ledger row
 * holds yet, so the server takes it as the same change. Its type may differ (a refused dislike
 * re-sent as today's substitution).
 */
export function replaceInPlace(
	entries: readonly OutboxEntry[],
	seq: number,
	envelope: Mutation
): OutboxEntry[] {
	return entries.map((e) => {
		if (e.seq !== seq) return e;
		if (envelope.id !== e.envelope.id) {
			throw new RangeError(`Fix re-queues ${e.envelope.id} under its own id, not ${envelope.id}`);
		}
		return queued(seq, envelope);
	});
}

// ---- The status the screens show ------------------------------------------------------------

/** active, or what the server last said: a 401 (signed out), a recovery session's 403. */
export type SyncSession = 'active' | 'signed-out' | 'passkey-required';

export interface StatusContext {
	online: boolean;
	/** A sync request is on its way. */
	inFlight: boolean;
	session: SyncSession;
	now: number;
	/** When the engine sends again after a failed batch (a 5xx, a timeout), while it waits. */
	retryAt: number | null;
}

/**
 * Saved · Saving… · Offline · N pending · Retrying in n s · N need attention · Sign in to sync · N
 * waiting · Finish adding your passkey. The words are the screens'.
 */
export type OutboxStatus =
	| { state: 'synced' }
	| { state: 'saving'; pending: number }
	| { state: 'offline'; pending: number }
	| { state: 'retrying'; seconds: number; pending: number }
	| { state: 'attention'; count: number }
	| { state: 'signed-out'; waiting: number }
	| { state: 'passkey'; waiting: number };

/**
 * One status, the first that holds: the session, changes that need the owner, offline, nothing
 * pending, a request on its way, the engine's wait, something ready to send, and otherwise the
 * soonest entry's wait.
 */
export function syncStatus(entries: readonly OutboxEntry[], context: StatusContext): OutboxStatus {
	const { online, inFlight, session, now, retryAt } = context;
	const pending = entries.length;
	if (session === 'signed-out') return { state: 'signed-out', waiting: pending };
	if (session === 'passkey-required') return { state: 'passkey', waiting: pending };
	const parked = entries.filter((e) => e.parked).length;
	if (parked > 0) return { state: 'attention', count: parked };
	if (!online) return { state: 'offline', pending };
	if (pending === 0) return { state: 'synced' };
	if (inFlight) return { state: 'saving', pending };
	const retrying = (at: number) => ({
		state: 'retrying' as const,
		seconds: Math.ceil((at - now) / 1000),
		pending
	});
	if (retryAt !== null && retryAt > now) return retrying(retryAt);
	const batch = nextBatch(entries, now, BATCH_CAPS.flush);
	if (batch.entries.length + batch.tooLarge.length > 0) return { state: 'saving', pending };
	// Nothing parked and nothing sendable: every entry waits, or is held behind one that does.
	const waits = entries.map((e) => (e.nextAt !== null && e.nextAt > now ? e.nextAt : Infinity));
	return retrying(Math.min(...waits));
}
