/**
 * The rest timer as the screen shows it (PRD §8), read from its timestamps (timers.ts) at `now`:
 * the countdown in whole seconds rounded up, so it shows 2:00 for a 2:00 rest at its start and
 * 0:00 only once it is over; then the time since it ended, counting up ('Rest over · 0:42 ago').
 * Change the words here.
 */
import { formatDuration } from '#lib/domain/units.ts';
import { restDone, restOverdue, restRemaining } from '#lib/domain/workout/timers.ts';
import type { RestClass, RestState } from '#lib/domain/workout/types.ts';

export type RestPhase = 'running' | 'paused' | 'over';

export interface RestReading {
	phase: RestPhase;
	/** m:ss: the time left, or since it ended. */
	time: string;
	/** What the eyebrow says: 'Rest', 'Paused' or 'Rest over'. */
	label: string;
	/** How much of it has passed, 0 to 1. */
	progress: number;
	/** Its whole length with every addition, m:ss. */
	total: string;
}

const LABELS: Record<RestPhase, string> = { running: 'Rest', paused: 'Paused', over: 'Rest over' };

export function readRest(rest: RestState, now: number): RestReading {
	const totalMs = rest.durationMs + rest.addedMs;
	const phase: RestPhase = restDone(rest, now)
		? 'over'
		: rest.pausedAt === null
			? 'running'
			: 'paused';
	const remaining = restRemaining(rest, now);
	const seconds =
		phase === 'over' ? Math.floor(restOverdue(rest, now) / 1000) : Math.ceil(remaining / 1000);
	return {
		phase,
		time: formatDuration(seconds),
		label: LABELS[phase],
		progress: totalMs > 0 ? 1 - remaining / totalMs : 1,
		total: formatDuration(Math.ceil(totalMs / 1000))
	};
}

/**
 * The instant a rest's readings turn over from: the countdown and the overtime both change on
 * the whole seconds from its end, so the screen's clock (clock.ts) ticks with them, never late.
 */
export function restAnchor(rest: RestState): number {
	return rest.startedAt + rest.durationMs + rest.addedMs;
}

/** The progress bar as one CSS animation from empty to full over the rest's whole length. */
export interface RestBar {
	/** Its whole length with every addition, ms. */
	durationMs: number;
	/** Minus how much of it has passed: the animation starts there. */
	delayMs: number;
	/** Whether it moves: a paused rest holds the bar where it stopped. */
	running: boolean;
}

/**
 * The bar of `rest` read at `now`, for an animation that starts then: the compositor fills it
 * from there with no JavaScript per frame, a paused one stands still, and one that is over is full.
 */
export function restBar(rest: RestState, now: number): RestBar {
	const durationMs = rest.durationMs + rest.addedMs;
	return {
		durationMs,
		// remaining - whole, never -0: at the start the delay is 0.
		delayMs: restRemaining(rest, now) - durationMs,
		running: rest.pausedAt === null && !restDone(rest, now)
	};
}

/**
 * Each rest class as the settings sheet and Train's rest timer name it, with what it covers
 * (restClassOf, timers.ts), in the order they show. A plain array, so a screen that does not
 * use it (the workout) tree-shakes it away.
 */
export const REST_CLASS_WORDS: readonly { restClass: RestClass; label: string; hint: string }[] = [
	{ restClass: 'main', label: 'Main lifts', hint: 'Squat, bench, deadlift and top sets' },
	{ restClass: 'compound', label: 'Other compounds', hint: 'Rows, presses, lunges' },
	{ restClass: 'isolation', label: 'Isolation', hint: 'Curls, raises, extensions' },
	{ restClass: 'timed', label: 'Timed', hint: 'Planks, holds, carries' }
];
