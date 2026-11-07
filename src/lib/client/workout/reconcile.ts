/**
 * Reconciliation with the server (the offline workout sync ADR, 'Reconciliation'): the view is the
 * server's rows with the pending mutations replayed on top, and this module fetches those rows.
 * It loads with the sync engine, on idle, never in the hydration path: a restore shows what
 * IndexedDB holds at once, and the screen never waits for a reconcile.
 *
 * - reconcile(workoutId), when online (at app start, on becoming visible, after a sync response):
 *   GET /api/workouts/[id], aborted after 10 s on its own timer. The rows are stored as they are
 *   (store.reconciled): another device's sets appear, a workout finished or abandoned elsewhere
 *   ends here too, a pending edit of a set deleted elsewhere is parked, the device state is never
 *   touched, and this device's pending changes still win in the view until they are acknowledged.
 * - A 404 deletes nothing. While the workout's workout.start is still in the outbox (started
 *   offline, or not flushed yet) the server has simply not seen it: everything is kept, and the
 *   reconcile after the flush applies the rows. After the start was acknowledged the server lost it
 *   (as after a restore): the local copy and every pending change are kept, their sends answer
 *   'deferred', and the 'Needs attention' cap (outbox-rules) surfaces them.
 * - adoptRemote(workoutId): a workout in progress on another device, built here from its rows and
 *   the kit pinned to its planned session (GET /api/workouts/kit?session=…, which answers a
 *   StartKit); an ad-hoc workout has none, and its rows alone render it.
 * Offline, a timeout, a network failure or any other answer changes nothing.
 * Plain .ts with no runes: the network, the clock's timers and navigator.onLine are injected.
 */
import type { CanonicalWorkout, StartKit } from '#lib/domain/workout/index.ts';
import type { AdoptOutcome, WorkoutStore } from './store.ts';

/** A reconcile GET without its answer after this long is aborted, and changes nothing. */
export const RECONCILE_TIMEOUT_MS = 10_000;

export const workoutUrl = (workoutId: string) => `/api/workouts/${encodeURIComponent(workoutId)}`;
export const kitUrl = (sessionId: string) =>
	`/api/workouts/kit?session=${encodeURIComponent(sessionId)}`;

export type ReconcileStore = Pick<WorkoutStore, 'outbox' | 'reconciled' | 'adopt'>;

/**
 * - reconciled: the server's rows are stored; not-held: this device does not hold the workout
 * - start-pending: a 404 before its workout.start was sent; lost: a 404 after it was acknowledged
 * - offline, failed (a timeout, the network, any other answer): nothing changed
 */
export type ReconcileOutcome =
	'reconciled' | 'not-held' | 'start-pending' | 'lost' | 'offline' | 'failed';

/** Besides the store's outcomes: missing (a 404), ended (not in progress), offline, failed. */
export type AdoptRemoteOutcome = AdoptOutcome | 'missing' | 'ended' | 'offline' | 'failed';

export interface ReconcileOptions {
	store: ReconcileStore;
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	/** navigator.onLine by default. */
	online?: () => boolean;
	setTimeout?: (run: () => void, ms: number) => unknown;
	clearTimeout?: (timer: unknown) => void;
}

export interface Reconciler {
	/** Throws StoreClosedError when the store closed meanwhile, as every store write does. */
	reconcile(workoutId: string): Promise<ReconcileOutcome>;
	adoptRemote(workoutId: string): Promise<AdoptRemoteOutcome>;
}

type Answer<T> = { ok: true; body: T } | { ok: false; status: number | null };

/** The rows of this workout, as the protocol shapes them; anything else is not stored. */
const isCanonical = (body: unknown, workoutId: string): body is CanonicalWorkout => {
	const c = body as Partial<CanonicalWorkout> | null;
	return c?.v === 1 && c.workout?.id === workoutId && Array.isArray(c.sets);
};

export function createReconciler({
	store,
	fetch: request = (url, init) => fetch(url, init),
	online = () => globalThis.navigator?.onLine ?? true,
	setTimeout: later = (run, ms) => setTimeout(run, ms),
	clearTimeout: cancel = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
}: ReconcileOptions): Reconciler {
	/** One bounded GET: the abort also covers reading the body. */
	async function get<T>(url: string): Promise<Answer<T>> {
		const controller = new AbortController();
		const timer = later(() => controller.abort(), RECONCILE_TIMEOUT_MS);
		try {
			const response = await request(url, {
				headers: { accept: 'application/json' },
				signal: controller.signal
			});
			if (!response.ok) return { ok: false, status: response.status };
			return { ok: true, body: (await response.json()) as T };
		} catch {
			return { ok: false, status: null };
		} finally {
			cancel(timer);
		}
	}

	async function rows(workoutId: string): Promise<Answer<CanonicalWorkout>> {
		const answer = await get<unknown>(workoutUrl(workoutId));
		if (answer.ok && !isCanonical(answer.body, workoutId)) return { ok: false, status: null };
		return answer as Answer<CanonicalWorkout>;
	}

	async function reconcile(workoutId: string): Promise<ReconcileOutcome> {
		if (!online()) return 'offline';
		const answer = await rows(workoutId);
		if (answer.ok) return (await store.reconciled(answer.body)) ? 'reconciled' : 'not-held';
		if (answer.status !== 404) return 'failed';
		const outbox = await store.outbox();
		const starting = outbox.some(
			({ envelope: m }) => m.type === 'workout.start' && m.workoutId === workoutId
		);
		return starting ? 'start-pending' : 'lost';
	}

	async function adoptRemote(workoutId: string): Promise<AdoptRemoteOutcome> {
		if (!online()) return 'offline';
		const answer = await rows(workoutId);
		if (!answer.ok) return answer.status === 404 ? 'missing' : 'failed';
		const canonical = answer.body;
		if (canonical.workout.status !== 'in_progress') return 'ended';
		const session = canonical.workout.plannedSessionId;
		let kit: StartKit | null = null;
		if (session !== null) {
			const pinned = await get<StartKit>(kitUrl(session));
			// A pinned session is immutable, so a 404 means none to pin: the rows alone render it.
			if (!pinned.ok && pinned.status !== 404) return 'failed';
			kit = pinned.ok ? pinned.body : null;
		}
		return store.adopt(canonical, kit);
	}

	return { reconcile, adoptRemote };
}
