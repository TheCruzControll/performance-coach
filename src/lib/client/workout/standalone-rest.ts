/**
 * Train's standalone rest timer (PRD §8, Train → Tools): a rest that belongs to no workout, kept
 * in localStorage under pc:rest:v1 as the same timestamps a workout's rest holds (timers.ts), so
 * a reload or a closed tab shows exactly the right time. It opens no workout and sends nothing.
 *
 * - Like the workout settings, it is device state, not account data: sign-out keeps it.
 * - A stored value that is not a valid rest reads as none, so no stored value breaks Train.
 * - A rest that ended more than STALE_REST_MS ago reads as none: Train does not greet the owner
 *   with 'Rest over · 26:14:03 ago' the next day.
 * - Storage that is missing, blocked or full is never an error: a read gives none, a write false.
 * Plain .ts with no runes; `storage` is an argument, so Vitest's unit project runs it.
 */
import { restOverdue } from '#lib/domain/workout/timers.ts';
import type { RestState } from '#lib/domain/workout/types.ts';

export const STANDALONE_REST_KEY = 'pc:rest:v1';

/** The part of localStorage the rest uses. */
export type RestStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * How long after it ended a rest still shows as over: an hour. An owner decision; change it here.
 */
export const STALE_REST_MS = 60 * 60_000;

/** The page's localStorage, or null where there is none or touching it throws (blocked storage). */
function pageStorage(): RestStorage | null {
	try {
		return (globalThis as { localStorage?: Storage }).localStorage ?? null;
	} catch {
		return null;
	}
}

const isInstant = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value);

const isLength = (value: unknown): value is number => isInstant(value) && value >= 0;

function isRest(value: unknown): value is RestState {
	if (typeof value !== 'object' || value === null) return false;
	const rest = value as Record<string, unknown>;
	return (
		isInstant(rest.startedAt) &&
		isLength(rest.durationMs) &&
		isLength(rest.addedMs) &&
		(rest.pausedAt === null || isInstant(rest.pausedAt))
	);
}

/** Whether the device holds a standalone rest, without reading it: Train's cheap check on load. */
export function holdsStandaloneRest(storage: RestStorage | null = pageStorage()): boolean {
	try {
		return !!storage?.getItem(STANDALONE_REST_KEY);
	} catch {
		return false;
	}
}

/** The device's standalone rest at `now`; null when there is none, it is not valid, or it is stale. */
export function readStandaloneRest(
	now: number,
	storage: RestStorage | null = pageStorage()
): RestState | null {
	let rest: unknown;
	try {
		rest = JSON.parse(storage?.getItem(STANDALONE_REST_KEY) ?? 'null');
	} catch {
		return null;
	}
	if (!isRest(rest)) return null;
	return restOverdue(rest, now) > STALE_REST_MS ? null : rest;
}

/**
 * Keeps `rest` as the device's standalone rest, or forgets it when null. False when the browser
 * could not keep it (private mode, a full or blocked storage): the timer still runs on the page.
 */
export function writeStandaloneRest(
	rest: RestState | null,
	storage: RestStorage | null = pageStorage()
): boolean {
	if (!storage) return false;
	try {
		if (rest) storage.setItem(STANDALONE_REST_KEY, JSON.stringify(rest));
		else storage.removeItem(STANDALONE_REST_KEY);
		return true;
	} catch {
		return false;
	}
}
