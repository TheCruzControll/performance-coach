/**
 * What a workout page loads once its first render has painted (active.svelte.ts's connect): the
 * store's write path and the page's one sync engine (sync.ts), in one chunk, so sync.ts is never in
 * the hydration path and adds no chunk the route must load first.
 *
 * Every change the store reports that may have added to the outbox flushes the engine: this page's
 * saved dispatches, from any view or sheet ('saved'), and another tab's writes ('view'). No view
 * starts or triggers its own. App start, 'online', becoming visible, the backoff timer and the
 * pagehide keepalive are the engine's own (sync.ts).
 *
 * The screens' sync status (status.svelte.ts) follows the engine until stop().
 *
 * A screen that opens online is reconciled: once the outbox has flushed, the active workout's rows
 * on the server are stored (reconcile.ts), so another device's changes show. The screen never
 * waits for it. Its 401 signs the engine out; any other answer from the app signs it back in. A
 * planned workout without its kit (a 401 purged it) is refilled with the pinned kit (adoptRemote).
 * A 401 on this page is final: an answer to a request sent before it stores no rows or kit.
 *
 * On a cold /workout load that reconcile answers from the GET the page's inline script started
 * (prepaint.ts), which left before the store could open, only while it cannot predate a change
 * this page knows of: until the engine has sent anything and until the store has reported any
 * change. Otherwise it is aborted and the reconcile sends its own, as before.
 */
import type { CanonicalWorkout, StartKit } from '#lib/domain/workout/index.ts';
import { createStore, type StoreChange, type StoreOptions, type WorkoutStore } from './store.ts';
import { createReconciler, takeEarlyRows } from './reconcile.ts';
import { outboxStatus } from './status.svelte.ts';
import { startSync, type SyncOptions } from './sync.ts';

/** The changes that flush: 'not-saved', 'purged' and 'closed' add nothing to send. */
export const FLUSH_ON: readonly StoreChange['type'][] = ['saved', 'view'];

export interface Online {
	store: WorkoutStore;
	/** The reconcile as the screen opened: settles when done, never rejects. */
	reconciled: Promise<void>;
	/** No more flushes: the page that started the engine is gone (a new session needs a new one). */
	stop(): void;
}

/** Opens the store, then starts its sync engine and flushes it on every change it reports. */
export async function goOnline(
	options: StoreOptions,
	sync: Omit<SyncOptions, 'store'> = {}
): Promise<Online> {
	let early = takeEarlyRows();
	/** Nothing sent and nothing changed since the page opened: the early GET is still current. */
	let untouched = true;
	const store = await createStore(options);
	const send = sync.fetch ?? ((url, init) => globalThis.fetch(url, init));
	const engine = startSync({
		...sync,
		store,
		fetch: (url, init) => ((untouched = false), send(url, init))
	});
	const unsubscribe = store.onChange(({ type }) => {
		untouched = false;
		// A failed round is retried on the engine's backoff timer.
		if (FLUSH_ON.includes(type)) engine.flush().catch(() => {});
	});
	const unfollow = outboxStatus.follow(engine);
	const { fetch, online, setTimeout, clearTimeout } = sync;
	// Checked as the write is queued: the store runs its writes in order, so a later purge still wins.
	const guarded = {
		outbox: store.outbox,
		reconciled: (c: CanonicalWorkout) =>
			engine.signedOutHere() ? Promise.resolve(false) : store.reconciled(c),
		adopt: (c: CanonicalWorkout, kit: StartKit | null) =>
			engine.signedOutHere() ? Promise.resolve('refused' as const) : store.adopt(c, kit)
	};
	/** The early GET, once: for this workout while untouched, else aborted. */
	const take = (workoutId: string | null) => {
		const taken = early;
		early = null;
		if (taken && untouched && taken.workoutId === workoutId) return taken;
		taken?.controller.abort();
		return null;
	};
	const reconciler = createReconciler({
		store: guarded,
		fetch,
		online,
		setTimeout,
		clearTimeout,
		early: take
	});
	async function reconcile(): Promise<void> {
		await engine.flush().catch(() => {});
		const active = await store.getActive();
		if (!active) return;
		const outcome = await reconciler.reconcile(active.workoutId);
		if (outcome === 'signed-out') return engine.signedOut();
		if (outcome === 'offline' || outcome === 'failed') return;
		await engine.signedIn();
		const view = store.snapshot(active.workoutId)?.view;
		if (view && !view.kit && view.workout.plannedSessionId !== null) {
			await reconciler.adoptRemote(active.workoutId);
		}
	}
	// A reconcile that never asked for the early GET (offline, nothing active) lets it go.
	const reconciled = reconcile()
		.catch(() => {})
		.finally(() => take(null));
	return {
		store,
		reconciled,
		stop() {
			unsubscribe();
			unfollow();
			engine.stop();
		}
	};
}
