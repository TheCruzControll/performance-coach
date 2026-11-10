/** One Event Timing entry of an interaction (perf-workout.e2e.ts's observer). */
export interface TimedEntry {
	id: number;
	duration: number;
}

/**
 * INP as web-vitals estimates it: the longest interaction, skipping one per 50 (at most 9). The
 * observer reports only entries over its durationThreshold, so `count` is every interaction that
 * happened, fast ones included: it, not the reported entries, picks how many to skip.
 */
export function inp(entries: TimedEntry[], count: number): number {
	const longest = new Map<number, number>();
	for (const { id, duration } of entries) longest.set(id, Math.max(duration, longest.get(id) ?? 0));
	const sorted = [...longest.values()].sort((a, b) => b - a);
	return sorted[Math.min(Math.floor(Math.max(count, sorted.length) / 50), 9)] ?? 0;
}

/**
 * The nearest-rank percentile: the smallest value at least `p` of them are at or under, as CrUX
 * reads a page's p75 over its loads. NaN for none.
 */
export function percentile(values: readonly number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? Number.NaN;
}
