/**
 * One second clock for the timers on screen (PRD §8), so the rest timer and the stopwatch change
 * on the same frame, never one a fraction of a second after the other. Each running timer joins
 * with its anchor, the instant its reading turns over from (whole seconds on from it), and how to
 * show a new time. The clock wakes on the leader's whole seconds and gives every timer the same
 * `now` in that one callback: the rest timer leads while it runs (its zero is what the vibration
 * and the tone mark, so it is never late), otherwise the first timer that joined. A timer that
 * follows is exact at each tick and at most a second behind its own turn.
 * A timeout per second, never an interval, so it never drifts from the anchor.
 */

export interface Beat {
	/** Epoch ms its reading turns over from, every whole second on. */
	anchor: number;
	/** The rest timer: the clock follows its seconds while it runs. */
	lead?: boolean;
	/** Shows the time at `now`. */
	tick: (now: number) => void;
}

/** The ms from `now` to the next whole second on from `anchor` (1000 on one). */
export function msToBoundary(anchor: number, now: number): number {
	const phase = (((now - anchor) % 1000) + 1000) % 1000;
	return 1000 - phase;
}

interface Timers {
	now: () => number;
	setTimeout: (run: () => void, ms: number) => unknown;
	clearTimeout: (timer: unknown) => void;
}

const browser: Timers = {
	now: () => Date.now(),
	setTimeout: (run, ms) => setTimeout(run, ms),
	clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
};

/** A clock over `timers` (the page's by default). */
export function createClock(timers: Timers = browser) {
	const beats = new Set<Beat>();
	let timer: unknown = null;

	const leader = () => {
		let first: Beat | undefined;
		for (const beat of beats) {
			if (beat.lead) return beat;
			first ??= beat;
		}
		return first;
	};

	function schedule() {
		if (timer !== null) timers.clearTimeout(timer);
		timer = null;
		const lead = leader();
		if (lead) timer = timers.setTimeout(fire, msToBoundary(lead.anchor, timers.now()));
	}

	function fire() {
		timer = null;
		const now = timers.now();
		for (const beat of [...beats]) beat.tick(now);
		schedule();
	}

	return {
		/** Ticks `beat` from its next whole second (or the leader's) until the returned leave. */
		join(beat: Beat): () => void {
			beats.add(beat);
			schedule();
			return () => {
				if (beats.delete(beat)) schedule();
			};
		}
	};
}

/** The page's one clock, which every timer on screen joins. */
export const clock = createClock();
