/**
 * An exercise's history for the exercise-history sheet (GET /api/exercises/[id]/history): its
 * sets newest first, a page at a time, grouped here into the sessions they were done in, and its
 * records (the best e1RM, always an estimate, and the heaviest set at each rep count).
 *
 * - Offline (navigator.onLine false) nothing is asked: the sheet shows the session it already has
 *   on the device, if any, and says so.
 * - A request that fails (a 5xx, the network) or gets no answer within HISTORY_TIMEOUT_MS is
 *   'failed', which the sheet shows as its error with Retry. The timer is our own
 *   AbortController's, never AbortSignal.timeout, so tests control it.
 */
import type { Instant, LoggedSet, PreviousPerformance } from '#lib/domain/workout/index.ts';

/**
 * How long the sheet waits for an answer before it shows its error with Retry (the M4 plan's
 * exercise-history slice: 5 s). Change it here.
 */
export const HISTORY_TIMEOUT_MS = 5_000;

/** A set as the endpoint sends it: what was logged, where and when. */
export interface HistorySet extends LoggedSet {
	id: number;
	workoutId: string;
	setIndex: number;
	isSkipped: boolean;
	performedAt: Instant;
}

/** The best e1RM, always an estimate, with the set it was estimated from (in kg). */
export interface HistoryBest {
	kind: 'estimated';
	value: number;
	set: HistorySet;
}

/** The heaviest load (in kg) lifted for a rep count. */
export interface HistoryRepMax {
	reps: number;
	weightKg: number;
	set: HistorySet;
}

/** What the sheet reads of the endpoint's answer. */
export interface ExerciseHistory {
	exercise: { id: string; name: string };
	previous: PreviousPerformance | null;
	/** Newest first. */
	sets: HistorySet[];
	/** The `before` that gives the next page; null on the last. */
	next: number | null;
	records: { bestE1rm: HistoryBest | null; repMaxes: HistoryRepMax[] };
}

/** What opens the sheet: the exercise, and the session this device holds of it, if any. */
export interface HistoryRequest {
	exerciseId: string;
	name: string;
	/** Shown offline: the kit's previous session or the attached one; none from History. */
	fallback?: PreviousPerformance | null;
}

export type HistoryLookup =
	| { state: 'ready'; history: ExerciseHistory }
	| { state: 'offline' }
	| { state: 'not-found' }
	| { state: 'failed' };

interface LookupOptions {
	/** A page's `next`, for the page after it. */
	before?: number | null;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	online?: boolean;
}

/** One page of the exercise's history, or why there is none. */
export async function fetchExerciseHistory(
	exerciseId: string,
	{
		before = null,
		fetch = globalThis.fetch,
		timeoutMs = HISTORY_TIMEOUT_MS,
		online = navigator.onLine
	}: LookupOptions = {}
): Promise<HistoryLookup> {
	if (!online) return { state: 'offline' };
	const query = before === null ? '' : `?before=${before}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(
			`/api/exercises/${encodeURIComponent(exerciseId)}/history${query}`,
			{ signal: controller.signal, headers: { accept: 'application/json' } }
		);
		if (response.status === 404) return { state: 'not-found' };
		if (!response.ok) return { state: 'failed' };
		return { state: 'ready', history: (await response.json()) as ExerciseHistory };
	} catch {
		return { state: 'failed' };
	} finally {
		clearTimeout(timer);
	}
}

/** One workout's sets of the exercise, in the order they were done. */
export interface HistorySession {
	workoutId: string;
	/** When its last set of the exercise was done. */
	at: Instant;
	sets: HistorySet[];
}

/**
 * The sets, newest first as pages give them, as the sessions they were done in, newest first.
 * The last session of a page may continue on the next: sets are grouped over every page loaded.
 */
export function sessionsOf(sets: readonly HistorySet[]): HistorySession[] {
	// By workout, not by run: two workouts' sets can interleave in time (two devices).
	const sessions = new Map<string, HistorySession>();
	for (const set of sets) {
		const session = sessions.get(set.workoutId);
		if (session) session.sets.unshift(set);
		else
			sessions.set(set.workoutId, { workoutId: set.workoutId, at: set.performedAt, sets: [set] });
	}
	return [...sessions.values()];
}
