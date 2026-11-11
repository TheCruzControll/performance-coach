/**
 * Workouts for the measurements (pure, plain Node): what the perf project (e2e/perf.e2e.ts) and
 * Lighthouse (scripts/lighthouse.ts) audit the workout and History screens on.
 * - finishedWorkout: a completed strength workout as a device sends it through POST
 *   /api/workouts/sync, so History has real rows to list and to open.
 * - activeWorkoutSeed: a workout in progress on this device, as workout.start leaves it in
 *   'pc-offline' (e2e/workout-support.ts seedWorkout's shape), so /workout opens in its active
 *   state. writeActiveWorkout puts it into a page's IndexedDB on the app's origin.
 * Every kit is made ad hoc first: a kit's planned session is not in the audited database, or is
 * one the audit must not complete.
 */
import type { StoredWorkout } from '../../src/lib/client/workout/db.ts';
import { DB_NAME, DB_VERSION, LAYOUT, STORES } from '../../src/lib/client/workout/names.ts';
import type {
	KitExercise,
	KitSet,
	LoggedSet,
	StartKit,
	StrengthKit
} from '../../src/lib/domain/workout/types.ts';
import { createMutation } from '../../src/lib/domain/workout/mutations.ts';
import type {
	Mutation,
	MutationInput,
	MutationType
} from '../../src/lib/domain/workout/mutations.ts';

/** The load a seeded set of an external-load exercise lifts when its kit computes none. */
export const FALLBACK_WEIGHT = 40;
/** The RPE a seeded set reports when its kit names no target. */
export const FALLBACK_RPE = 8;
/** A seeded workout's mutations are this far apart, from its start. */
const STEP_MS = 60_000;

/** The kit with its planned session, and every slot's, taken off. */
export function adHoc<K extends StartKit>(kit: K): K {
	const unplanned = { ...kit, plannedLineage: null, plannedSessionId: null, programId: null };
	if (kit.kind !== 'strength') return unplanned;
	const exercises = (kit as StrengthKit).exercises.map((slot) => ({
		...slot,
		plannedLineage: null
	}));
	return { ...unplanned, exercises } as K;
}

/** One planned set as done: its amount by the exercise's measure, its load by its load type. */
export function loggedSet(slot: KitExercise, set: KitSet, unit: LoggedSet['unit']): LoggedSet {
	const { measure, loadType } = slot.exercise;
	return {
		reps: measure === 'reps' ? (set.repsMin ?? set.repsMax ?? 8) : null,
		seconds: measure === 'time' ? (set.seconds ?? 30) : null,
		metres: measure === 'distance' ? (set.metres ?? 100) : null,
		weight: loadType === 'external' ? (set.prescribedWeight?.value ?? FALLBACK_WEIGHT) : null,
		assistance: null,
		unit,
		rpe: set.targetRpe ?? FALLBACK_RPE,
		missedReps: 0,
		isWarmup: set.role === 'warm_up',
		isExtra: false
	};
}

/**
 * A finished strength workout: workout.start at `startedAt`, every planned set of the kit logged
 * as prescribed, then workout.finish with a session RPE, each a minute after the one before.
 */
export function finishedWorkout(
	strength: StrengthKit,
	startedAt: number,
	newId: () => string = () => crypto.randomUUID()
): { workoutId: string; mutations: Mutation[] } {
	const kit = adHoc(strength);
	const workoutId = newId();
	const mutations: Mutation[] = [];
	const add = <T extends MutationType>(
		type: T,
		input: Omit<MutationInput<T>, 'workoutId' | 'at'>
	) => {
		const at = new Date(startedAt + mutations.length * STEP_MS).toISOString();
		const mutation = createMutation(type, { workoutId, at, ...input } as MutationInput<T>, newId);
		mutations.push(mutation);
	};
	const { kind, title, sessionType, discipline } = kit;
	const unplanned = { plannedSessionId: null, plannedLineage: null, programId: null };
	add('workout.start', { payload: { kind, title, sessionType, discipline, ...unplanned } });
	for (const slot of kit.exercises) {
		const place = { position: slot.position, plannedLineage: null, exerciseId: slot.exercise.id };
		slot.sets.forEach((set, i) => {
			const payload = { ...place, setIndex: i + 1, ...loggedSet(slot, set, kit.units.weight) };
			add('set.log', { payload });
		});
	}
	const durationSeconds = (mutations.length * STEP_MS) / 1000;
	add('workout.finish', { payload: { sessionRpe: FALLBACK_RPE, durationSeconds } });
	return { workoutId, mutations };
}

/** A workout in progress on a device: its stored record and its outbox entries, without a seq. */
export interface ActiveSeed {
	workoutId: string;
	record: StoredWorkout;
	entries: { envelope: Mutation; attempts: number; failingSince: null; nextAt: null }[];
}

/**
 * The workout `kit` started `minutesAgo` before `now`, as workout.start leaves it: on its first
 * exercise, its stopwatch running from the start, and its workout.start not sent yet.
 */
export function activeWorkoutSeed(
	startKit: StartKit,
	now: number,
	{
		minutesAgo = 12,
		workoutId = crypto.randomUUID() as string
	}: { minutesAgo?: number; workoutId?: string } = {}
): ActiveSeed {
	const kit = adHoc(startKit);
	const started = now - minutesAgo * 60_000;
	const startedAt = new Date(started).toISOString();
	const { kind, title, sessionType, discipline, plannedSessionId, plannedLineage, programId } = kit;
	const start = createMutation('workout.start', {
		workoutId,
		at: startedAt,
		payload: { kind, title, sessionType, discipline, plannedSessionId, plannedLineage, programId }
	});
	const record: StoredWorkout = {
		id: workoutId,
		kind,
		title,
		startedAt,
		status: 'in_progress',
		finishedAt: null,
		kit,
		canonical: null,
		device: {
			position: 1,
			drafts: {},
			rest: null,
			stopwatch: { startedAt: started, accumulatedMs: 0, runningSince: started },
			added: [],
			attached: {}
		}
	};
	const entries = [{ envelope: start, attempts: 0, failingSince: null, nextAt: null }];
	return { workoutId, record, entries };
}

/** Anything that runs a function in a page: a Playwright Page. */
interface PageLike {
	evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
}

/**
 * Writes `seed` into the page's 'pc-offline' in one transaction, creating the database as the app
 * declares it (names.ts) when it does not exist. The page must be on the app's origin.
 */
export async function writeActiveWorkout(page: PageLike, seed: ActiveSeed): Promise<void> {
	await page.evaluate(
		async ({ name, version, layout, stores, record, entries }) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(name, version);
				request.onupgradeneeded = () => {
					for (const [store, { keyPath, autoIncrement, indexes }] of Object.entries(layout)) {
						if (request.result.objectStoreNames.contains(store)) continue;
						const created = request.result.createObjectStore(store, {
							keyPath,
							autoIncrement: autoIncrement ?? false
						});
						for (const [index, options] of Object.entries(indexes ?? {})) {
							created.createIndex(index, options.keyPath, { unique: options.unique });
						}
					}
				};
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			const tx = db.transaction([stores.workouts, stores.outbox], 'readwrite');
			tx.objectStore(stores.workouts).put(record);
			for (const entry of entries) tx.objectStore(stores.outbox).add(entry);
			await new Promise((resolve, reject) => {
				tx.oncomplete = resolve;
				tx.onerror = () => reject(tx.error);
			});
			db.close();
		},
		{ name: DB_NAME, version: DB_VERSION, layout: LAYOUT, stores: STORES, ...seed }
	);
}
