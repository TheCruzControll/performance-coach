/** A frame longer than the gate: the gap between two animation frames, ending at `at`. */
export interface LongFrame {
	at: number;
	ms: number;
}

/**
 * The frames longer than `limit` ms in `times` (requestAnimationFrame timestamps, in order), each
 * the gap between two consecutive frames, to 0.1 ms. A frame that overlaps a `busy` window (an
 * interaction's Event Timing [startTime, startTime + duration]) is the one an input was answered
 * in: INP measures and gates it, so it is left out here. What is left is motion: the frames of an
 * animation or a drag that came late with no input to answer.
 */
export function longFrames(
	times: readonly number[],
	busy: readonly (readonly [number, number])[],
	limit: number
): LongFrame[] {
	const long: LongFrame[] = [];
	for (let i = 1; i < times.length; i++) {
		const from = times[i - 1]!;
		const at = times[i]!;
		const ms = Math.round((at - from) * 10) / 10;
		if (ms <= limit) continue;
		if (busy.some(([start, end]) => from < end && at > start)) continue;
		long.push({ at, ms });
	}
	return long;
}

/**
 * The frames of `times` from the one `start` falls in: a motion that starts with a tap is watched
 * from that tap, not from the window's opening, before which the harness finds what to tap and the
 * page may still be loading. All of them when `start` is undefined (a motion watched as it runs).
 */
export function framesFrom(times: readonly number[], start: number | undefined): number[] {
	if (start === undefined) return [...times];
	const after = times.findIndex((at) => at > start);
	return after === -1 ? [] : times.slice(Math.max(0, after - 1));
}
