/**
 * The workout pages' restore read (the offline workout sync ADR, 'Restore'): the active workout's
 * inputs, read from 'pc-offline' with raw IndexedDB, so the first render needs neither idb nor the
 * store's write path, which load after it (active.svelte.ts). Same reads as the store's
 * getActive: the newest workout in progress, and its outbox entries in seq order.
 * - It never creates 'pc-offline' (the upgrade of a missing one is aborted), and it closes at once.
 * - A 'pc-offline' without the workout stores reads as none: the store recreates it when it opens.
 * - A database a newer app has upgraded is 'upgraded'.
 * - It rejects when this browser refuses IndexedDB (missing, private mode): the page says so.
 */
import type { WorkoutInputs } from '#lib/domain/workout/project.ts';
import type { StoredWorkout } from './db.ts';
import { DB_NAME, DB_VERSION, OUTBOX_INDEXES, STORES } from './names.ts';
import type { OutboxEntry } from './outbox-rules.ts';

export type RestoreRead =
	{ status: 'none' | 'upgraded' } | { status: 'found'; inputs: WorkoutInputs };

const result = <T>(request: IDBRequest<T>) =>
	new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});

/** 'pc-offline' as it is, or null when it does not exist. */
function openExisting(): Promise<IDBDatabase | null> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME);
		let created = false;
		request.onupgradeneeded = () => {
			created = true;
			request.transaction!.abort();
		};
		request.onerror = () => (created ? resolve(null) : reject(request.error));
		request.onsuccess = () => resolve(request.result);
	});
}

export async function readActive(): Promise<RestoreRead> {
	const db = await openExisting();
	if (!db) return { status: 'none' };
	try {
		if (db.version > DB_VERSION) return { status: 'upgraded' };
		const names = [STORES.workouts, STORES.outbox];
		if (!names.every((name) => db.objectStoreNames.contains(name))) return { status: 'none' };
		const tx = db.transaction(names, 'readonly');
		const workouts = await result<StoredWorkout[]>(tx.objectStore(STORES.workouts).getAll());
		const active = workouts
			.filter((w) => w.status === 'in_progress')
			.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
		if (!active) return { status: 'none' };
		const byWorkout = tx.objectStore(STORES.outbox).index(OUTBOX_INDEXES.byWorkout);
		const entries = await result<OutboxEntry[]>(byWorkout.getAll(active.id));
		const { id: workoutId, kit, canonical, device } = active;
		const pending = entries.map((entry) => entry.envelope);
		return { status: 'found', inputs: { workoutId, kit, canonical, pending, device } };
	} finally {
		db.close();
	}
}
