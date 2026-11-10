/**
 * What sign-out loads lazily, never in a route's initial JS (the offline workout sync ADR, 'Losing
 * the session'): sign-out flushes first, for at most 5 s, and asks before deleting what is left.
 *
 * - unsyncedAfterFlush: the changes still unsynced after one flush. Nothing pending (or a device
 *   without 'pc-offline') answers 0 without opening the store, so it never creates the database.
 *   The flush is a fresh engine's: what is parked, or still waiting on its backoff, is not sent and
 *   counts as left. A recovery session's 403 and an offline device answer at once; another tab
 *   holding the sync lock runs the flush to the limit.
 * - keepOnlyUnsynced: a signed-out URL without sign-out's marker (a typed URL, the no-JavaScript
 *   sign-out) deletes what the server already holds, as a 401 does (purgeServerCopies), and keeps
 *   the outbox until the owner deletes it or signs in. Only called with something pending: the
 *   purge marks the device signed out, and only a sync request clears that mark.
 *
 * Neither ever blocks the deletion of 'pc-offline': each closes the store it opened before it
 * returns, and a store closes itself on versionchange anyway (db.ts). Each closes it with the
 * store's own close, never a 'signed-out' message, which would close the page for good: after 'Stay
 * signed in', /workout in this tab opens the store again, and a second sign-out flushes again.
 */
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import { openTabChannel } from './channel.ts';
import { pendingCount } from './probe.ts';
import { createStore } from './store.ts';
import { startSync } from './sync.ts';
import type { SyncOptions } from './sync.ts';

/** How long sign-out waits for the outbox to flush before it asks (ADR: ≤ 5 s). */
export const FLUSH_LIMIT_MS = 5_000;

/**
 * Unsynced workout changes left after one flush bounded to `limitMs`; 0, without creating
 * 'pc-offline', when none were pending. Never rejects.
 */
export async function unsyncedAfterFlush(
	sync: Omit<SyncOptions, 'store'> = {},
	limitMs = FLUSH_LIMIT_MS
): Promise<number> {
	if ((await pendingCount()) === 0) return 0;
	const later = sync.setTimeout ?? ((run: () => void, ms: number) => setTimeout(run, ms));
	const cancel =
		sync.clearTimeout ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
	try {
		// No other tab is told anything: this page only sends.
		const store = await createStore({ table: strengthTable, channel: null });
		const engine = startSync({ events: null, ...sync, store });
		let timer: unknown = null;
		try {
			const flushed = engine.flush().catch(() => {});
			const limit = new Promise<void>((resolve) => (timer = later(() => resolve(), limitMs)));
			await Promise.race([flushed, limit]);
		} finally {
			cancel(timer);
			engine.stop();
			store.close();
		}
	} catch {
		// The store would not open (this page saw it closed): what is pending is still the answer.
	}
	return pendingCount();
}

/** Deletes what the server already holds (purgeServerCopies), keeping only unsynced changes. */
export async function keepOnlyUnsynced(): Promise<void> {
	// The other tabs hear 'purged' and show the signed-out state.
	const store = await createStore({ table: strengthTable, channel: openTabChannel() });
	try {
		await store.purgeServerCopies();
	} finally {
		store.close();
	}
}
