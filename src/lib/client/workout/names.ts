/**
 * The on-device workout database, by name (the offline workout sync ADR). No runtime imports: the
 * e2e helpers import this file too, so a spec that seeds or reads the database cannot drift from
 * what the app opens.
 *
 * 'pc-offline' is the name M2's sign-out already deletes. Every store is declared at version 1,
 * so a later slice adds fields to a store's values, never a store: that would need a version 2,
 * which closes every open tab's store ('App updated — reload to continue').
 */
export const DB_NAME = 'pc-offline';
export const DB_VERSION = 1;

export const STORES = {
	/** One record per workout: its header, start kit, canonical rows and device state. */
	workouts: 'workouts',
	/** The pending mutations, in order (autoIncrement seq). */
	outbox: 'outbox',
	/** Start kits saved for later, by planned-session lineage. */
	kits: 'kits',
	/** The cached exercise library and its digest. */
	library: 'library',
	/** The owner's units, the last sync. */
	meta: 'meta'
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

export const OUTBOX_INDEXES = {
	/** A mutation's id: unique, so no mutation is ever queued twice. */
	byMutation: 'byMutation',
	/** A mutation's workout. */
	byWorkout: 'byWorkout'
} as const;

export interface StoreLayout {
	keyPath: string;
	autoIncrement?: boolean;
	indexes?: Record<string, { keyPath: string; unique: boolean }>;
}

/** How version 1 declares each store, for the app's upgrade and the e2e helpers alike. */
export const LAYOUT: Record<StoreName, StoreLayout> = {
	workouts: { keyPath: 'id' },
	outbox: {
		keyPath: 'seq',
		autoIncrement: true,
		indexes: {
			[OUTBOX_INDEXES.byMutation]: { keyPath: 'envelope.id', unique: true },
			[OUTBOX_INDEXES.byWorkout]: { keyPath: 'envelope.workoutId', unique: false }
		}
	},
	kits: { keyPath: 'lineage' },
	library: { keyPath: 'id' },
	meta: { keyPath: 'key' }
};
