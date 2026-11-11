/**
 * The active workout for the workout pages (the offline workout sync ADR, 'Restore'), with the
 * route's reducer table. Restore reads IndexedDB alone (restore.ts), so it never waits for the
 * network; the projection and the route's reducers load through the page's chunk loader while it
 * reads, so neither is in the first render. The store (store.ts, with idb and every write) loads after the first render, through
 * the page's chunk loader, and from then on every change it reports is shown. It loads with the
 * page's one sync engine (online.ts), which close() stops. A write asked for before then (a tap on
 * the rest timer, the stopwatch or the logger) waits for it and runs as it opens (write()).
 *
 * - loading: restoring (the page shows its skeleton)
 * - empty: no workout is in progress on this device
 * - active: the workout in progress
 * - completed: the workout this page shows was finished (here, or on another device), or the restore
 *   found one finished here and still waiting to sync. It stays when its rows leave the device
 *   once synced (store.ts), until the page is left.
 * - elsewhere: the workout in progress is another kind; the page sends it to that kind's route
 *   before any view renders
 * - no-storage: this browser cannot keep a workout (IndexedDB is missing or refuses to open)
 * - app-updated: a newer app upgraded the database (before or under the page), or a chunk of this
 *   build is gone. A deletion (sign-out) closes the store instead: nothing is left to show.
 *
 * A thin wrapper, as the client README's M4 rule asks: $state.raw over the projection's immutable
 * snapshots, never $state.snapshot, and no binding named after a rune.
 */
import type { SessionKind } from '#lib/domain/training/types.ts';
import type { WorkoutView } from '#lib/domain/workout/index.ts';
import type { AnyTable } from '#lib/domain/workout/project.ts';
import type { CloseReason } from './db.ts';
import { readActive } from './restore.ts';
import type { StoreChange, WorkoutSnapshot, WorkoutStore } from './store.ts';

export type ActiveSnapshot = WorkoutSnapshot & { view: WorkoutView };

export type Restore =
	| { phase: 'loading' | 'empty' | 'no-storage' | 'app-updated' }
	| { phase: 'active' | 'completed'; snapshot: ActiveSnapshot }
	| { phase: 'elsewhere'; kind: SessionKind };

/** Loads a code-split chunk, or answers null when it is gone (the page's loader says so). */
export type ChunkLoad = <T>(load: () => Promise<T>) => Promise<T | null>;

/** A write through the store, now or once it opens (ActiveWorkout.write). */
export type StoreWrite = (run: (store: WorkoutStore) => unknown, key?: string) => void;

export class ActiveWorkout {
	current = $state.raw<Restore>({ phase: 'loading' });
	/**
	 * Null until connect() has opened it and read its workout (so a write through it is synchronous),
	 * and when it could not. Reactive: the page marks it.
	 */
	store = $state.raw<WorkoutStore | null>(null);
	/** A 401 purged this device as the restore found it (restore.ts): the page hides the workout. */
	signedOut = $state.raw(false);
	/** Finish was asked for (the menu, or the strength view's after the last exercise): it opens. */
	finishing = $state.raw(false);
	readonly #loadTable: () => Promise<AnyTable>;
	/** The route's reducer table, once restore() has loaded it. */
	#table: AnyTable | null = null;
	/** Lets go of the store and stops the engine; null once closed. */
	#stop: (() => void) | null = () => {};
	/** The writes asked for before the store opened, in the order asked. */
	#early: { run: (store: WorkoutStore) => unknown; key?: string }[] = [];

	constructor(table: () => Promise<AnyTable>) {
		this.#loadTable = table;
	}

	/** The workout in progress, from IndexedDB alone; a chunk that is gone shows 'App updated'. */
	async restore(load: ChunkLoad): Promise<void> {
		const code = load(() =>
			Promise.all([this.#loadTable(), import('#lib/domain/workout/project.ts')])
		);
		const read = await readActive().catch(() => null);
		const loaded = await code;
		if (!loaded) return;
		const [table, { project }] = loaded;
		this.#table = table;
		if (!read) {
			this.current = { phase: 'no-storage' };
			return;
		}
		if (read.status !== 'found') {
			return read.status === 'upgraded' ? this.#closed('upgraded') : this.#show(null);
		}
		this.signedOut = read.signedOut;
		const view = project(table, read.inputs);
		this.#show({ workoutId: read.inputs.workoutId, view, notSaved: [], pending: 0 });
	}

	/**
	 * Opens the store once restored (for writes, and the other tabs' changes) and starts its sync
	 * engine; null if it can't, or if the page closed meanwhile.
	 */
	async connect(load: ChunkLoad): Promise<WorkoutStore | null> {
		const table = this.#table;
		const { phase } = this.current;
		if (!table || (phase !== 'active' && phase !== 'empty' && phase !== 'completed')) return null;
		const module = await load(() => import('./online.ts'));
		if (!module) return null;
		try {
			const { store, stop } = await module.goOnline({ table });
			const unsubscribe = store.onChange((change) => this.#hear(store, change));
			const end = () => (unsubscribe(), stop());
			if (!this.#stop) return (end(), null);
			this.#stop = end;
			// A finished workout shown stays: read into memory, so its changes show.
			const done = this.current.phase === 'completed' && this.current.snapshot.workoutId;
			this.#show(await (done ? store.load(done) : store.getActive()));
			this.store = store;
			// The taps that came first, in order, each on the workout as it now is. Only into a
			// workout still in progress: one finished meanwhile shows as completed instead.
			for (const { run } of this.#early.splice(0)) {
				if (this.current.phase !== 'active') continue;
				try {
					run(store);
				} catch (error) {
					// A failing tap fails as it would have in its own handler, never as this page's store.
					queueMicrotask(() => {
						throw error;
					});
				}
			}
			return store;
		} catch (error) {
			this.#fail(error);
			return null;
		}
	}

	/**
	 * Runs `run` with the store: at once when it is open, else as connect() opens it, so a tap that
	 * comes first is never lost. A write with the `key` of one still waiting is the same tap again
	 * (nothing on screen has changed since) and waits no second time.
	 */
	write: StoreWrite = (run, key) => {
		if (this.store) return void run(this.store);
		if (key !== undefined && this.#early.some((early) => early.key === key)) return;
		this.#early.push({ run, key });
	};

	/** A chunk of this build is gone: only a reload continues. */
	stale(): void {
		this.current = { phase: 'app-updated' };
	}

	close(): void {
		this.#stop?.();
		this.#stop = null;
		this.#early = [];
	}

	#fail(error: unknown) {
		// db.ts's StoreClosedError, by name: importing the class would put idb in the first render.
		if (error instanceof Error && error.name === 'StoreClosedError') {
			this.#closed((error as Error & { reason: CloseReason }).reason);
		} else {
			this.current = { phase: 'no-storage' };
		}
	}

	#closed(reason: CloseReason) {
		if (this.current.phase === 'app-updated') return;
		this.current = { phase: reason === 'upgraded' ? 'app-updated' : 'empty' };
	}

	#show(snapshot: WorkoutSnapshot | null) {
		if (this.current.phase === 'app-updated') return;
		const view = snapshot?.view;
		const status = view?.workout.status;
		if (!snapshot || !view || status === 'abandoned') {
			if (this.current.phase !== 'completed') this.current = { phase: 'empty' };
		} else if (view.workout.kind !== this.#table?.kind) {
			this.current = { phase: 'elsewhere', kind: view.workout.kind };
		} else {
			const phase = status === 'in_progress' ? 'active' : 'completed';
			this.current = { phase, snapshot: { ...snapshot, view } };
		}
	}

	#hear(store: WorkoutStore, change: StoreChange) {
		if (change.type === 'closed') return this.#closed(change.reason);
		const shown = 'snapshot' in this.current ? this.current.snapshot.workoutId : null;
		if (change.type !== 'purged' && change.workoutId === shown) {
			return this.#show(store.snapshot(change.workoutId));
		}
		// A purge, or another workout (one another tab started or adopted): read which is active.
		if (change.type === 'purged' || change.type === 'view') {
			void store.getActive().then(
				(snapshot) => this.#show(snapshot),
				(error: unknown) => this.#fail(error)
			);
		}
	}
}
