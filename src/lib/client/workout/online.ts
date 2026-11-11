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
 */
import type { CanonicalWorkout, StartKit } from '#lib/domain/workout/index.ts';
import { createStore, type StoreChange, type StoreOptions, type WorkoutStore } from './store.ts';
import { createReconciler } from './reconcile.ts';
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
	const store = await createStore(options);
	const engine = startSync({ ...sync, store });
	const unsubscribe = store.onChange(({ type }) => {
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
	const reconciler = createReconciler({ store: guarded, fetch, online, setTimeout, clearTimeout });
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
	const reconciled = reconcile().catch(() => {});
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
