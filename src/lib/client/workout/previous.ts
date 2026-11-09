/**
 * Last time for an exercise the kit has no previous sets for: a substitute, or an exercise added
 * to the workout (the M4 plan's decision on previous sets). When such a slot becomes current, the
 * device asks the server for that exercise's last session (GET /api/exercises/[id]/history) and
 * attaches it to the workout (kit.attach), so it shows inline and a reload keeps it. Offline, or
 * when the server does not answer in PREVIOUS_TIMEOUT_MS, nothing is attached and the slot reads
 * 'No previous sets on this device'; the next time it becomes current, it asks again.
 */
import type { PreviousPerformance, SlotView, WorkoutView } from '#lib/domain/workout/index.ts';
import type { WorkoutStore } from './store.ts';

/** How long the device waits for an exercise's last session before showing it has none here. */
export const PREVIOUS_TIMEOUT_MS = 5_000;

/** What the lookup found: the last session, none (null), or no answer ('unavailable'). */
export type PreviousLookup = PreviousPerformance | null | 'unavailable';

/** Whether a slot's exercise needs its previous sets fetched: neither the kit nor the device has them. */
export function needsPrevious(view: WorkoutView, slot: SlotView): boolean {
	return (
		view.device.attached[slot.exerciseId] === undefined && slot.kit?.exercise.id !== slot.exerciseId
	);
}

interface LookupOptions {
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	online?: boolean;
}

/** The exercise's last session from the server. A 404 (an exercise it does not know) is none. */
export async function fetchPrevious(
	exerciseId: string,
	{
		fetch = globalThis.fetch,
		timeoutMs = PREVIOUS_TIMEOUT_MS,
		online = navigator.onLine
	}: LookupOptions = {}
): Promise<PreviousLookup> {
	if (!online) return 'unavailable';
	try {
		const response = await fetch(`/api/exercises/${encodeURIComponent(exerciseId)}/history`, {
			signal: AbortSignal.timeout(timeoutMs),
			headers: { accept: 'application/json' }
		});
		if (response.status === 404) return null;
		if (!response.ok) return 'unavailable';
		const { previous } = (await response.json()) as { previous: PreviousPerformance | null };
		return previous ?? null;
	} catch {
		return 'unavailable';
	}
}

/**
 * Looks up the last session of the exercise `slot` performs and attaches what it found to the
 * workout: 'attached', or 'unavailable' when nothing could be (offline, a timeout, a failure).
 */
export async function attachPrevious(
	store: Pick<WorkoutStore, 'dispatch'>,
	view: WorkoutView,
	slot: SlotView,
	options?: LookupOptions
): Promise<'attached' | 'unavailable'> {
	const exerciseId = slot.exerciseId;
	const previous = await fetchPrevious(exerciseId, options);
	if (previous === 'unavailable') return previous;
	await store.dispatch({ type: 'kit.attach', workoutId: view.workout.id, exerciseId, previous })
		.saved;
	return 'attached';
}
