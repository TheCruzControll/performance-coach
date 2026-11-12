/**
 * What the screens outside the workout pages may know about the device's workout: the resume bar,
 * sign-out's pending check, the sign-in page. Raw IndexedDB, without idb or the projection, so it
 * costs those screens almost nothing.
 * - It never creates 'pc-offline': on a device without it, the open's upgrade is aborted.
 * - A 'pc-offline' without the workout stores (M2's sign-out specs make one with a 'sets' store)
 *   reads as empty, as does any failure: these are hints, never errors.
 * - It always closes, and closes at once on versionchange, so it never blocks sign-out.
 */
import type { SessionKind } from '#lib/domain/training/types.ts';
import type { Instant, StopwatchState } from '#lib/domain/workout/index.ts';
import type { SavedKit, StoredWorkout } from './db.ts';
import { DB_NAME, OUTBOX_INDEXES, STORES } from './names.ts';

export interface ActiveSummary {
	workoutId: string;
	kind: SessionKind;
	title: string;
	startedAt: Instant;
	/** The planned session it was started from (its kit's), or null: Today reads Resume on it. */
	plannedLineage: string | null;
	/** Its changes not synced yet. */
	pending: number;
	/** The header's stopwatch, so the resume bar reads the time the workout page does. */
	stopwatch: StopwatchState;
}

/** 'pc-offline' as it is, or null when it does not exist or cannot be opened. */
function openExisting(): Promise<IDBDatabase | null> {
	return new Promise((resolve) => {
		const request = indexedDB.open(DB_NAME);
		request.onupgradeneeded = () => request.transaction!.abort(); // it did not exist
		request.onerror = () => resolve(null);
		request.onsuccess = () => {
			const db = request.result;
			db.onversionchange = () => db.close();
			resolve(db);
		};
	});
}

const result = <T>(request: IDBRequest<T>) =>
	new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});

async function read<T>(
	empty: T,
	query: (tx: IDBTransaction) => Promise<T>,
	stores: string[] = [STORES.workouts, STORES.outbox]
): Promise<T> {
	let db: IDBDatabase | null = null;
	try {
		db = await openExisting();
		if (!db) return empty;
		// Throws NotFoundError on a database without the workout stores: empty too.
		return await query(db.transaction(stores, 'readonly'));
	} catch {
		return empty;
	} finally {
		db?.close();
	}
}

/** The workout in progress on this device, with its changes waiting; null when there is none. */
export function activeSummary(): Promise<ActiveSummary | null> {
	return read(null, async (tx) => {
		const workouts = await result<StoredWorkout[]>(tx.objectStore(STORES.workouts).getAll());
		const active = workouts.find((w) => w.status === 'in_progress');
		if (!active) return null;
		const outbox = tx.objectStore(STORES.outbox).index(OUTBOX_INDEXES.byWorkout);
		const pending = await result(outbox.count(active.id));
		const { id: workoutId, kind, title, startedAt, device } = active;
		const plannedLineage = active.kit?.plannedLineage ?? null;
		return {
			workoutId,
			kind,
			title,
			startedAt,
			plannedLineage,
			pending,
			stopwatch: device.stopwatch
		};
	});
}

/** A finished workout this device holds whose changes have not all synced yet. */
export interface WaitingSummary {
	workoutId: string;
	kind: SessionKind;
	title: string;
	startedAt: Instant;
	pending: number;
}

/**
 * The finished workouts with changes still waiting, newest first, as History lists them above
 * the synced ones; none on a device without the database.
 */
export function waitingToSync(): Promise<WaitingSummary[]> {
	return read([], async (tx) => {
		const workouts = await result<StoredWorkout[]>(tx.objectStore(STORES.workouts).getAll());
		const outbox = tx.objectStore(STORES.outbox).index(OUTBOX_INDEXES.byWorkout);
		const waiting: WaitingSummary[] = [];
		for (const { id: workoutId, kind, title, startedAt, status } of workouts) {
			if (status !== 'completed') continue;
			const pending = await result(outbox.count(workoutId));
			if (pending > 0) waiting.push({ workoutId, kind, title, startedAt, pending });
		}
		return waiting.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	});
}

/** Every change on this device not synced yet, of any workout. */
export function pendingCount(): Promise<number> {
	return read(0, (tx) => result(tx.objectStore(STORES.outbox).count()));
}

/** A workout's planned session and where it stands: all the offline screen asks of it. */
export interface PlannedRun {
	kind: SessionKind;
	status: StoredWorkout['status'];
	plannedLineage: string;
}

/**
 * The start kits saved on this device (Today's and Train's, coming-kits.ts), oldest first, and the workouts
 * started from a planned session; both empty on a device without the database.
 */
export function savedKits(): Promise<{ kits: SavedKit[]; runs: PlannedRun[] }> {
	return read(
		{ kits: [], runs: [] },
		async (tx) => {
			const kits = await result<SavedKit[]>(tx.objectStore(STORES.kits).getAll());
			const workouts = await result<StoredWorkout[]>(tx.objectStore(STORES.workouts).getAll());
			const runs: PlannedRun[] = [];
			for (const { kind, status, kit } of workouts) {
				if (kit?.plannedLineage) runs.push({ kind, status, plannedLineage: kit.plannedLineage });
			}
			return { kits: kits.sort((a, b) => a.savedAt - b.savedAt), runs };
		},
		[STORES.kits, STORES.workouts]
	);
}
