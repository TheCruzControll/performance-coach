/**
 * The rest timer as the screen shows it (PRD §8), read from its timestamps (timers.ts) at `now`:
 * the countdown in whole seconds rounded up, so it shows 2:00 for a 2:00 rest at its start and
 * 0:00 only once it is over; then the time since it ended, counting up ('Rest over · 0:42 ago').
 * Change the words here.
 */
import { formatDuration } from '#lib/domain/units.ts';
import { restDone, restOverdue, restRemaining } from '#lib/domain/workout/timers.ts';
import type { RestState } from '#lib/domain/workout/types.ts';

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
 * The ms until what a running rest shows next changes: the countdown and the overtime both turn
 * over on the same whole seconds from its end, so the screen ticks with them, never a second late.
 */
export function msToNextTick(rest: RestState, now: number): number {
	const end = rest.startedAt + rest.durationMs + rest.addedMs;
	const phase = (((now - end) % 1000) + 1000) % 1000;
	return 1000 - phase;
}
