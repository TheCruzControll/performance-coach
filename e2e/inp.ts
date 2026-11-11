/** One Event Timing entry of an interaction (perf-workout.e2e.ts's observer). */
export interface TimedEntry {
	id: number | string;
	duration: number;
}

/**
 * INP as web-vitals estimates it: the longest interaction, skipping one per 50 (at most 9). The
 * observer reports only entries over its durationThreshold, so `count` is every interaction that
 * happened, fast ones included: it, not the reported entries, picks how many to skip.
 */
export function inp(entries: TimedEntry[], count: number): number {
	const longest = new Map<number | string, number>();
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

/** A tap's kind, tagged on pointerdown, while the element tapped is still in the page. */
export interface Tag<K extends string> {
	at: number;
	kind: K;
}

/** An Event Timing entry, with the kind its own target names (or the fallback when it has none). */
export interface KindedEntry<K extends string> extends TimedEntry {
	startTime: number;
	kind: K;
}

/** The longest a tap's first reported entry starts after its pointerdown and still is that tap. */
export const TAG_WINDOW_MS = 1_000;

/**
 * Each interaction's kind, by id. Event Timing reports an entry once its frame has painted, and its
 * target is null by then if the element has left the page (a sheet's Close, Up next's Start, a
 * swiped card), so those read as `fallback`. The tag of the last pointerdown at or before the
 * interaction's first entry, within TAG_WINDOW_MS, names the element as it was tapped; without
 * one (a key press) the first of the entries' own kinds that is not `fallback` does.
 */
export function attribute<K extends string>(
	entries: readonly KindedEntry<K>[],
	tags: readonly Tag<K>[],
	fallback: K
): Map<number | string, K> {
	const byId = new Map<number | string, KindedEntry<K>[]>();
	for (const entry of entries) byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry]);
	const kinds = new Map<number | string, K>();
	for (const [id, of] of byId) {
		const first = Math.min(...of.map((entry) => entry.startTime));
		const tag = tags
			.filter((t) => t.at <= first && first - t.at <= TAG_WINDOW_MS)
			.reduce<Tag<K> | undefined>((last, t) => (last && last.at > t.at ? last : t), undefined);
		kinds.set(id, tag?.kind ?? of.find((entry) => entry.kind !== fallback)?.kind ?? fallback);
	}
	return kinds;
}
