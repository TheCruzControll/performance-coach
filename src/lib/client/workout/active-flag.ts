/**
 * The launch flag (launch.ts): while a workout is in progress on this device, localStorage holds
 * its id and kind (nothing the owner wrote), for the prerendered /offline page's inline script to
 * open it on a launch without the network. The store keeps it (store.ts): written with a workout
 * in progress, dropped when it finishes, is abandoned or discarded, or leaves the device, and set
 * again from IndexedDB by getActive. Sign-out deletes it (signout.ts, by this key). A stale flag
 * costs one prerendered workout page, which shows what the device holds.
 * Storage that is missing, blocked or full is never an error.
 *
 * Its own module, apart from launch.ts: the store's chunk carries this, and the /offline page's
 * client build carries neither (launch.ts's script is server-rendered only).
 */

/** launch.ts's LAUNCH_SCRIPT reads this key (launch.test.ts checks). */
export const ACTIVE_WORKOUT_KEY = 'pc:active-workout:v1';

/** The part of localStorage the flag uses. */
export type FlagStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The page's localStorage, or null where there is none or touching it throws (blocked storage). */
function pageStorage(): FlagStorage | null {
	try {
		return (globalThis as { localStorage?: Storage }).localStorage ?? null;
	} catch {
		return null;
	}
}

/** Runs `use` on the storage; a failure (missing, blocked, full) is ignored. */
function attempt(storage: FlagStorage | null, use: (storage: FlagStorage) => void) {
	if (!storage) return;
	try {
		use(storage);
	} catch {
		// Storage refused: a launch offline shows the offline screen, as before.
	}
}

/** The flagged workout's id, or null. */
function flagged(storage: FlagStorage): string | null {
	try {
		const flag = JSON.parse(storage.getItem(ACTIVE_WORKOUT_KEY) ?? 'null') as unknown;
		const id = (flag as { workoutId?: unknown } | null)?.workoutId;
		return typeof id === 'string' ? id : null;
	} catch {
		return null;
	}
}

/** A workout as the store keeps it, as much of it as the flag follows. */
export interface FlaggedWorkout {
	id: string;
	kind: 'strength' | 'run' | 'other';
	status: string;
}

/** A workout the store wrote or read: flagged while in progress, else its flag is dropped. */
export function noteWorkout(workout: FlaggedWorkout, storage = pageStorage()): void {
	if (workout.status !== 'in_progress') return workoutGone(workout.id, storage);
	attempt(storage, (s) =>
		s.setItem(
			ACTIVE_WORKOUT_KEY,
			JSON.stringify({ v: 1, workoutId: workout.id, kind: workout.kind })
		)
	);
}

/** A workout left the device or ended: its flag is dropped (another workout's stays). */
export function workoutGone(workoutId: string, storage = pageStorage()): void {
	attempt(storage, (s) => {
		if (flagged(s) === workoutId) s.removeItem(ACTIVE_WORKOUT_KEY);
	});
}

/** No workout is in progress on this device. */
export function clearActiveWorkout(storage = pageStorage()): void {
	attempt(storage, (s) => s.removeItem(ACTIVE_WORKOUT_KEY));
}
