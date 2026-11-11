/**
 * The fresh kit of a workout the start flow began from a kit saved on this device (start.ts), so
 * Start never waits on the network. Loaded by the workout page once its store is open, only for
 * the workout kit-mark.ts names. GET /api/workouts/kit (start.ts fetchKit, KIT_TIMEOUT_MS) in the
 * background, then:
 * - the fresh copy is saved on the device, with the owner's units, for the next start;
 * - it replaces the workout's kit (kit.attach) when it differs, the same planned session, and
 *   nothing has been done in the workout yet (untouched): a set, a swap, an added exercise, a
 *   value typed. Once anything has, the workout keeps the kit it started with: positions and
 *   prescriptions never change under logged sets.
 * - a fresh kit pinned to another planned session (a plan edit since: ADR 0010 gives the week's
 *   sessions new ids) cannot replace the kit, which pins the workout: 'replanned', while the
 *   workout is untouched, and the page offers to start again from it (startAfresh).
 * Unreachable, the mark stays and a later load of the page asks again. A 401 or a 404 changes
 * nothing here: the page's sync engine handles a lost session, and the workout runs as saved. A
 * device a 401 purged holds no kit for the workout (store.ts purgeServerCopies), so nothing is
 * asked then.
 */
import type { StartKit, WorkoutView } from '#lib/domain/workout/index.ts';
import { clearKitRefresh } from './kit-mark.ts';
import { discardInProgress, fetchKit, inProgress, type KitOptions } from './start.ts';
import type { WorkoutStore } from './store.ts';

export type Refreshed =
	'attached' | 'replanned' | 'saved' | 'unchanged' | 'skipped' | 'unreachable';

/** Nothing done in the workout yet, so its kit may still be replaced. */
export function untouched(view: WorkoutView): boolean {
	const { device } = view;
	return (
		view.workout.status === 'in_progress' &&
		!view.run &&
		!view.other &&
		device.added.length === 0 &&
		Object.keys(device.drafts).length === 0 &&
		!device.session &&
		view.slots.every((s) => s.state === 'planned' && s.sets.length === 0 && !s.substitution)
	);
}

const same = (a: StartKit, b: StartKit) => JSON.stringify(a) === JSON.stringify(b);

type Store = Pick<WorkoutStore, 'snapshot' | 'saveKit' | 'saveUnits' | 'dispatch'>;

export async function refreshKit(
	store: Store,
	workoutId: string,
	options: KitOptions = {}
): Promise<Refreshed> {
	const before = store.snapshot(workoutId)?.view;
	const lineage = before?.kit?.plannedLineage;
	if (!before || !lineage || !untouched(before)) return 'skipped';
	const answer = await fetchKit(lineage, options);
	if (!answer.ok) return answer.reason === 'unreachable' ? 'unreachable' : 'skipped';
	const fresh = answer.kit;
	await store.saveKit(lineage, fresh);
	await store.saveUnits(fresh.units);
	// As the workout is now: the owner may have logged a set while the kit was on its way.
	const view = store.snapshot(workoutId)?.view;
	if (!view?.kit || same(view.kit, fresh)) return 'unchanged';
	const pinned =
		fresh.kind === view.kit.kind && fresh.plannedSessionId === view.kit.plannedSessionId;
	if (!untouched(view)) return 'saved';
	if (!pinned) return 'replanned';
	await store.dispatch({ type: 'kit.attach', workoutId, kit: fresh }).saved;
	return 'attached';
}

/**
 * Replanned: the untouched workout leaves this device (discardInProgress) and the start URL of its
 * session, which starts from the fresh kit now saved. Null, and the workout stays, once anything
 * has been done in it or the discard was not saved.
 */
export async function startAfresh(store: WorkoutStore, workoutId: string): Promise<string | null> {
	const view = store.snapshot(workoutId)?.view;
	const lineage = view?.kit?.plannedLineage;
	const held = await inProgress(store);
	if (!view || !lineage || !untouched(view) || held?.workoutId !== workoutId) return null;
	if (!(await discardInProgress(held, { store }))) return null;
	return `/workout?start=${encodeURIComponent(lineage)}`;
}

/** refreshKit, then the mark cleared unless the server could not be reached. */
export async function refreshMarked(
	store: Store,
	workoutId: string,
	options: KitOptions & { storage?: Parameters<typeof clearKitRefresh>[0] } = {}
): Promise<Refreshed> {
	const refreshed = await refreshKit(store, workoutId, options);
	if (refreshed !== 'unreachable') clearKitRefresh(options.storage);
	return refreshed;
}
