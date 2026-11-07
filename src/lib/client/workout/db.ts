/**
 * The on-device workout database, 'pc-offline', through idb (the offline workout sync ADR). Every
 * store is declared at version 1 (names.ts). Opening it:
 * - creates it when it does not exist
 * - deletes and recreates a 'pc-offline' that lacks a store, such as the one M2's sign-out specs
 *   create with a single 'sets' store
 * - refuses a database a newer app has upgraded, as 'upgraded'
 * On versionchange (sign-out's deleteDatabase, or a newer app's upgrade) the connection closes at
 * once, so it never blocks the deletion, and this page never opens the database again: a stale
 * tab can never recreate what sign-out deleted. Reloading the page is the way back.
 */
import { deleteDB, openDB, unwrap } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import type { SessionKind } from '#lib/domain/training/types.ts';
import type { CanonicalWorkout, Instant } from '#lib/domain/workout/index.ts';
import type {
	DeviceState,
	KitExerciseMeta,
	KitUnits,
	StartKit
} from '#lib/domain/workout/index.ts';
import type { WorkoutStatus } from '#lib/domain/workout/index.ts';
import { DB_NAME, DB_VERSION, LAYOUT, STORES } from './names.ts';
import type { StoreName } from './names.ts';
import type { OutboxEntry } from './outbox-rules.ts';

/** A workout as the device keeps it: its inputs, and the header the probe reads without them. */
export interface StoredWorkout {
	/** The workout's client id: its workout.start's id. */
	id: string;
	kind: SessionKind;
	title: string;
	startedAt: Instant;
	/** From the projection when last written; 'in_progress' is the active workout. */
	status: WorkoutStatus;
	finishedAt: Instant | null;
	kit: StartKit | null;
	/** The server's rows, keyed by client ids; null until a sync response carries them. */
	canonical: CanonicalWorkout | null;
	device: DeviceState;
}

export interface SavedKit {
	lineage: string;
	kit: StartKit;
	/** Epoch ms on this device. */
	savedAt: number;
}

export interface CachedLibrary {
	id: 'exercises';
	digest: string;
	exercises: KitExerciseMeta[];
	savedAt: number;
}

export interface MetaValues {
	units: KitUnits;
	/** Epoch ms of the last sync response. */
	lastSync: number;
	/**
	 * Mutation ids the owner discarded that the server has not yet claimed as discarded: every sync
	 * request carries them first (store.ts discard). A sign-out's purge keeps them.
	 */
	discarded: string[];
}
export type MetaRecord = {
	[K in keyof MetaValues]: { key: K; value: MetaValues[K] };
}[keyof MetaValues];

export interface WorkoutSchema extends DBSchema {
	workouts: { key: string; value: StoredWorkout };
	outbox: { key: number; value: OutboxEntry; indexes: { byMutation: string; byWorkout: string } };
	kits: { key: string; value: SavedKit };
	library: { key: string; value: CachedLibrary };
	meta: { key: keyof MetaValues; value: MetaRecord };
}

export type WorkoutDb = IDBPDatabase<WorkoutSchema>;

/** Why the database closed under this page: sign-out deleted it, or a newer app upgraded it. */
export type CloseReason = 'deleted' | 'upgraded';

export class StoreClosedError extends Error {
	override name = 'StoreClosedError';
	readonly reason: CloseReason;
	constructor(reason: CloseReason) {
		super(`The workout store is closed: the database was ${reason}`);
		this.reason = reason;
	}
}

/** The pages (their IndexedDB) that saw the database close: they never open it again. */
const closedPages = new WeakMap<IDBFactory, CloseReason>();

const STORE_NAMES = Object.values(STORES) as StoreName[];

function open(onClose: (reason: CloseReason) => void): Promise<WorkoutDb> {
	const page = indexedDB;
	const close = (reason: CloseReason) => {
		closedPages.set(page, reason);
		onClose(reason);
	};
	return openDB<WorkoutSchema>(DB_NAME, DB_VERSION, {
		upgrade(db) {
			const raw = unwrap(db);
			for (const name of STORE_NAMES) {
				if (raw.objectStoreNames.contains(name)) continue;
				const { keyPath, autoIncrement = false, indexes = {} } = LAYOUT[name];
				const store = raw.createObjectStore(name, { keyPath, autoIncrement });
				for (const [index, { keyPath, unique }] of Object.entries(indexes)) {
					store.createIndex(index, keyPath, { unique });
				}
			}
		},
		blocking(_current, next, event) {
			(event.target as IDBDatabase).close();
			close(next === null ? 'deleted' : 'upgraded');
		},
		// The browser closed it (site data cleared): what it held is gone, as after a deletion.
		terminated: () => close('deleted')
	});
}

/** Opens 'pc-offline' with every store, or throws StoreClosedError (see above). */
export async function openWorkoutDb(onClose: (reason: CloseReason) => void): Promise<WorkoutDb> {
	const seen = closedPages.get(indexedDB);
	if (seen) throw new StoreClosedError(seen);
	let db: WorkoutDb;
	try {
		db = await open(onClose);
	} catch (error) {
		if (error instanceof DOMException && error.name === 'VersionError') {
			throw new StoreClosedError('upgraded');
		}
		throw error;
	}
	if (STORE_NAMES.every((name) => db.objectStoreNames.contains(name))) return db;
	db.close();
	await deleteDB(DB_NAME);
	return open(onClose);
}
