/**
 * The rest timer and the workout stopwatch (PRD §8; the offline workout sync ADR): pure state
 * machines over absolute epoch-ms instants on this device's clock, never tick counters. Every
 * reading takes `now`, so a refreshed, reopened or backgrounded tab shows exactly the right time
 * from the stored state alone, and a state is plain numbers that IndexedDB and JSON keep as is.
 *
 * - Every change returns a new state, or the same one when nothing changes, and never alters the
 *   state it is given: the projection's reducers keep them as immutable values.
 * - A device clock moved backwards never shows more than a rest's duration, a negative overtime,
 *   or a stopwatch below the time it has already counted.
 * - Which rest a set gets: restFor, from the prescription, the device default for the exercise's
 *   rest class (restClassOf), or 2:00.
 */
import type { BaselineLift } from '../training/types.ts';
import type { ExerciseTag, Measure, MovementPattern, SetRole } from '../training/vocabulary.ts';
import type { KitExerciseMeta, KitSet, RestClass, RestState, StopwatchState } from './types.ts';

// ---- The rest timer -------------------------------------------------------------------------

/** What +30 s adds. */
export const REST_STEP_MS = 30_000;

const isPositive = (ms: number) => Number.isFinite(ms) && ms > 0;

/** Its whole length: the duration and every addition. */
const totalOf = (rest: RestState) => rest.durationMs + rest.addedMs;

/** How long it has run, pauses left out; never negative, whichever way the clock moved. */
const elapsedOf = (rest: RestState, now: number) =>
	Math.max(0, (rest.pausedAt ?? now) - rest.startedAt);

/** A rest of `durationMs`, running from `now`; a duration that is not a positive number is none. */
export function startRest(now: number, durationMs: number): RestState {
	return {
		startedAt: now,
		durationMs: isPositive(durationMs) ? durationMs : 0,
		pausedAt: null,
		addedMs: 0
	};
}

/** The time left, from its whole length down to 0. */
export function restRemaining(rest: RestState, now: number): number {
	return Math.max(0, totalOf(rest) - elapsedOf(rest, now));
}

/** Whether it is over: it ran out, or was skipped. */
export function restDone(rest: RestState, now: number): boolean {
	return elapsedOf(rest, now) >= totalOf(rest);
}

/** How long ago it ended, counting up ('Rest over · 0:42 ago'); 0 until then. */
export function restOverdue(rest: RestState, now: number): number {
	return Math.max(0, elapsedOf(rest, now) - totalOf(rest));
}

/** Stops the countdown where it stands. A paused rest, or one that is over, is unchanged. */
export function pauseRest(rest: RestState, now: number): RestState {
	if (rest.pausedAt !== null || restDone(rest, now)) return rest;
	return { ...rest, pausedAt: now };
}

/** Counts down again from where it was paused, wherever the clock has moved meanwhile. */
export function resumeRest(rest: RestState, now: number): RestState {
	if (rest.pausedAt === null) return rest;
	return { ...rest, startedAt: now - elapsedOf(rest, now), pausedAt: null };
}

/** Back to its whole duration, the additions dropped; running or paused as it was. */
export function resetRest(rest: RestState, now: number): RestState {
	return { ...rest, startedAt: now, addedMs: 0, pausedAt: rest.pausedAt === null ? null : now };
}

/** Ends it now: it reads done, its overtime counting from now. One already over is unchanged. */
export function skipRest(rest: RestState, now: number): RestState {
	if (restDone(rest, now)) return rest;
	return { ...rest, startedAt: now - rest.durationMs, addedMs: 0, pausedAt: null };
}

/**
 * Adds `ms` (30 s by default), running or paused. Once it is over, the time is added from now,
 * not from when it ended. An amount that is not a positive number changes nothing.
 */
export function addRest(rest: RestState, now: number, ms = REST_STEP_MS): RestState {
	if (!isPositive(ms)) return rest;
	const from = restDone(rest, now)
		? { ...rest, startedAt: (rest.pausedAt ?? now) - totalOf(rest) }
		: rest;
	return { ...from, addedMs: from.addedMs + ms };
}

// ---- The workout stopwatch ------------------------------------------------------------------

/** A stopwatch that has not started: it reads 0. */
export const STOPWATCH_IDLE: StopwatchState = Object.freeze({
	startedAt: null,
	accumulatedMs: 0,
	runningSince: null
});

/** A stopwatch running from `now`. */
export function startStopwatch(now: number): StopwatchState {
	return { startedAt: now, accumulatedMs: 0, runningSince: now };
}

/** Its running time: every finished stretch, and the current one (never negative). */
export function stopwatchElapsed(stopwatch: StopwatchState, now: number): number {
	const running = stopwatch.runningSince === null ? 0 : Math.max(0, now - stopwatch.runningSince);
	return stopwatch.accumulatedMs + running;
}

/** Banks the current stretch and stops. A paused stopwatch is unchanged. */
export function pauseStopwatch(stopwatch: StopwatchState, now: number): StopwatchState {
	if (stopwatch.runningSince === null) return stopwatch;
	return { ...stopwatch, accumulatedMs: stopwatchElapsed(stopwatch, now), runningSince: null };
}

/** Runs again from `now`; one that never started starts. A running stopwatch is unchanged. */
export function resumeStopwatch(stopwatch: StopwatchState, now: number): StopwatchState {
	if (stopwatch.runningSince !== null) return stopwatch;
	return { ...stopwatch, startedAt: stopwatch.startedAt ?? now, runningSince: now };
}

/** Back to 0 from `now`, running or paused as it was. One that never started is unchanged. */
export function resetStopwatch(stopwatch: StopwatchState, now: number): StopwatchState {
	if (stopwatch.startedAt === null) return stopwatch;
	return {
		startedAt: now,
		accumulatedMs: 0,
		runningSince: stopwatch.runningSince === null ? null : now
	};
}

// ---- Which rest a set gets ------------------------------------------------------------------

/** Rest in seconds per rest class, as the device keeps it. */
export type RestDefaults = Readonly<Record<RestClass, number>>;

/**
 * The device's rest per class until the owner changes it, when a prescription names none: a main
 * lift 3:00, another compound 2:00, an isolation exercise 1:30 and a timed one 1:00. An owner
 * decision (the M4 plan's open questions): change the values here.
 */
export const DEFAULT_REST_SECONDS: RestDefaults = Object.freeze({
	main: 180,
	compound: 120,
	isolation: 90,
	timed: 60
});

/** The rest when neither the prescription nor the device names one for the class: 2:00. */
export const FALLBACK_REST_SECONDS = 120;

/** What restClassOf reads: a catalogue exercise's fields, or one of the owner's own. */
export interface RestClassInput {
	pattern: MovementPattern;
	measure: Measure;
	tags: readonly ExerciseTag[];
	/** The M2 lift a catalogue exercise is; the owner's own exercises have none. */
	baselineLift?: BaselineLift | null;
}

/** A top set rests as a main lift, whatever the exercise. */
const isTopSet = (set: { role: SetRole } | null | undefined) => set?.role === 'top';

/**
 * An exercise's rest class, or a set's when `set` is given:
 * 1. main: a baseline or competition lift, or a top set
 * 2. isolation: the isolation pattern
 * 3. timed: the time measure
 * 4. otherwise compound
 * The server gives each exercise of a kit and of the library its class, with no set.
 */
export function restClassOf(exercise: RestClassInput, set?: { role: SetRole } | null): RestClass {
	if (exercise.baselineLift || exercise.tags.includes('competition') || isTopSet(set)) {
		return 'main';
	}
	if (exercise.pattern === 'isolation') return 'isolation';
	return exercise.measure === 'time' ? 'timed' : 'compound';
}

const isSeconds = (value: number | null | undefined): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * The rest a set starts, in ms:
 * 1. the prescription's, a prescribed 0 included
 * 2. else the device default for the exercise's rest class (a top set's is a main lift's)
 * 3. else 2:00
 * `exercise` is the kit's or the library's, which carry their class; `set` is null for a set
 * with no prescription (an added exercise's).
 */
export function restFor(
	set: Pick<KitSet, 'role' | 'restSeconds'> | null,
	exercise: Pick<KitExerciseMeta, 'restClass'>,
	defaults: Partial<RestDefaults>
): number {
	const prescribed = set?.restSeconds;
	if (isSeconds(prescribed)) return prescribed * 1000;
	const fallback = defaults[isTopSet(set) ? 'main' : exercise.restClass];
	return (isSeconds(fallback) ? fallback : FALLBACK_REST_SECONDS) * 1000;
}
