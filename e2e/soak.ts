import { inp, type TimedEntry } from './inp';

/** The page's JS heap and DOM after a full garbage collection, once `sets` sets were logged. */
export interface HeapSample {
	sets: number;
	heapBytes: number;
	nodes: number;
	listeners: number;
}

/**
 * The heap's growth over a long session, as a fraction of the warm heap: from the first sample at
 * or past `warmSets` (the first sets load the sheet's, Up next's and the rest timer's code, which is
 * not a leak) to the last. Throws without a later sample than the warm one to compare with.
 */
export function heapGrowth(
	samples: readonly HeapSample[],
	warmSets: number
): { warm: HeapSample; last: HeapSample; growth: number } {
	const warm = samples.find((s) => s.sets >= warmSets);
	const last = samples.at(-1);
	if (!warm || !last || last.sets <= warm.sets)
		throw new Error(`no heap sample after the ${warmSets}-set warm-up to compare it with`);
	return { warm, last, growth: (last.heapBytes - warm.heapBytes) / warm.heapBytes };
}

/** An Event Timing interaction, with how many sets were logged when it happened. */
export interface PhasedEntry extends TimedEntry {
	set: number;
}

/**
 * INP late in the workout: over the interactions from set `from` on (inp.ts's estimate, `taps`
 * being every tap then, the fast ones the observer omits included), with the slowest of them and
 * how many there were.
 */
export function lateInp(
	entries: readonly PhasedEntry[],
	from: number,
	taps: number
): { inp: number; slowest: number; interactions: number } {
	const late = entries.filter((entry) => entry.set >= from);
	return {
		inp: inp(late, taps),
		slowest: Math.max(0, ...late.map((entry) => entry.duration)),
		interactions: new Set(late.map((entry) => entry.id)).size
	};
}
