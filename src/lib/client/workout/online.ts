/**
 * What a workout page loads on idle, after first render (active.svelte.ts's connect): the store's
 * write path and the page's one sync engine (sync.ts), in one chunk, so sync.ts is never in the
 * hydration path and adds no chunk the route must load first.
 *
 * Every change the store reports that may have added to the outbox flushes the engine: this page's
 * saved dispatches, from any view or sheet ('saved'), and another tab's writes ('view'). No view
 * starts or triggers its own. App start, 'online', becoming visible, the backoff timer and the
 * pagehide keepalive are the engine's own (sync.ts).
 */
import { createStore, type StoreChange, type StoreOptions, type WorkoutStore } from './store.ts';
import { startSync, type SyncOptions } from './sync.ts';

/** The changes that flush: 'not-saved', 'purged' and 'closed' add nothing to send. */
export const FLUSH_ON: readonly StoreChange['type'][] = ['saved', 'view'];

export interface Online {
	store: WorkoutStore;
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
	return {
		store,
		stop() {
			unsubscribe();
			engine.stop();
		}
	};
}
