/**
 * The active workout for the workout pages (the offline workout sync ADR, 'Restore'), with the
 * route's reducer table. Restore reads IndexedDB alone (restore.ts), so it never waits for the
 * network; the store (store.ts, with idb and every write) loads after the first render, through
 * the page's chunk loader, and from then on every change it reports is shown. It loads with the
 * page's one sync engine (online.ts), which close() stops.
 *
 * - loading: restoring (the page shows its skeleton)
 * - empty: no workout is in progress on this device
 * - active: the workout in progress
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
import { project } from '#lib/domain/workout/project.ts';
import type { AnyTable } from '#lib/domain/workout/project.ts';
import type { CloseReason } from './db.ts';
import { readActive } from './restore.ts';
import type { StoreChange, WorkoutSnapshot, WorkoutStore } from './store.ts';

export type ActiveSnapshot = WorkoutSnapshot & { view: WorkoutView };

export type Restore =
	| { phase: 'loading' | 'empty' | 'no-storage' | 'app-updated' }
	| { phase: 'active'; snapshot: ActiveSnapshot }
	| { phase: 'elsewhere'; kind: SessionKind };

/** Loads a code-split chunk, or answers null when it is gone (the page's loader says so). */
export type ChunkLoad = <T>(load: () => Promise<T>) => Promise<T | null>;

export class ActiveWorkout {
	current = $state.raw<Restore>({ phase: 'loading' });
	/** Null until connect() has opened it, and when it could not. */
	store: WorkoutStore | null = null;
	readonly #table: AnyTable;
	/** Lets go of the store and stops the engine; null once closed. */
	#stop: (() => void) | null = () => {};

	constructor(table: AnyTable) {
		this.#table = table;
	}

	/** The workout in progress, from IndexedDB alone. */
	async restore(): Promise<void> {
		let read: Awaited<ReturnType<typeof readActive>>;
		try {
			read = await readActive();
		} catch {
			this.current = { phase: 'no-storage' };
			return;
		}
		if (read.status !== 'found') {
			return read.status === 'upgraded' ? this.#closed('upgraded') : this.#show(null);
		}
		const view = project(this.#table, read.inputs);
		this.#show({ workoutId: read.inputs.workoutId, view, notSaved: [] });
	}

	/**
	 * Opens the store once restored (for writes, and the other tabs' changes) and starts its sync
	 * engine; null if it can't, or if the page closed meanwhile.
	 */
	async connect(load: ChunkLoad): Promise<WorkoutStore | null> {
		if (this.current.phase !== 'active' && this.current.phase !== 'empty') return null;
		const module = await load(() => import('./online.ts'));
		if (!module) return null;
		try {
			const { store, stop } = await module.goOnline({ table: this.#table });
			const unsubscribe = store.onChange((change) => this.#hear(change));
			const end = () => (unsubscribe(), stop());
			if (!this.#stop) return (end(), null);
			this.#stop = end;
			this.store = store;
			this.#show(await store.getActive());
			return store;
		} catch (error) {
			this.#fail(error);
			return null;
		}
	}

	/** A chunk of this build is gone: only a reload continues. */
	stale(): void {
		this.current = { phase: 'app-updated' };
	}

	close(): void {
		this.#stop?.();
		this.#stop = null;
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
		if (!snapshot || !view || view.workout.status !== 'in_progress') {
			this.current = { phase: 'empty' };
		} else if (view.workout.kind !== this.#table.kind) {
			this.current = { phase: 'elsewhere', kind: view.workout.kind };
		} else {
			this.current = { phase: 'active', snapshot: { ...snapshot, view } };
		}
	}

	#hear(change: StoreChange) {
		const store = this.store;
		if (!store) return;
		if (change.type === 'closed') return this.#closed(change.reason);
		const shown = this.current.phase === 'active' ? this.current.snapshot.workoutId : null;
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
