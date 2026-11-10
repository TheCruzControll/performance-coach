/**
 * What db:explain measures of a page load (m6-plan 'analytics-explain'): the server time the owner
 * waits for, serialisation included, and the page data it sends.
 * - A load runs WARM_UPS times untimed, then TIMED_RUNS times. Each run is the route's load
 *   followed by devalue.stringify of its result, as SvelteKit serialises page data for
 *   __data.json; the median and p95 of the timed runs are reported.
 * - The page data's size is that string gzipped (gzip's default level), as the CDN sends it.
 * - PAGE_TARGET_MS is reported, never gated: a planner and a machine on CI and on Neon differ. The
 *   gate is PAGE_LIMIT_MS on the median, and PAGE_DATA_LIMIT_BYTES on the gzipped page data.
 *
 * The levers (m6-plan), in order. Every plan already uses its index; the time is Node's CPU.
 * 1. Narrower columns: muscle lists as text, parsed once per value, saved about 20 ms at 'all' but
 *    turned setFacts at 'all' into a Seq Scan, failing its index gate: not kept.
 * 2. Route-level concurrency: one executor runs one query at a time, and CPU (overview 'all' about
 *    440 ms of its 485–620 ms) is not hidden by overlapping reads: not applied.
 * 3. SQL pre-aggregation of stored outputs: no stored output holds these figures.
 * 4, 5. An index is not missing; a closed-week cache table needs a schema slot (owner decision).
 * Applied: the overview works out only the strength headline it shows and dates PRs and e1RM lines
 * from SECTIONS_FIRST_DAYS; the Strength view works out weekly hard sets once. Paired local medians
 * (M1 Pro, CPU ms, wall in brackets), before → after: overview 'all' 821–832 → 441–446
 * (1244–1359 → 485–619), overview 12w 323–326 → 105–112 (418–441 → 163–199), strength 'all'
 * 492–507 → 423–496, strength 12w 251–253 unchanged (120 with RECORDS_FROM 'loaded').
 * Then, over CI's 300 ms (overview 'all' 497, strength 'all' 652, strength 12w 339): setFacts
 * sends its rows as one JSON array (its row plan and index unchanged), as decoding 15k rows field
 * by field cost more than any figure; the Strength view reads muscle-group targets only for the
 * weeks Progress lists (lastGroupWeeks: one program's version, not every program's of two years);
 * prescriptionFacts reads each planned exercise without the library names; a set's PR candidates
 * are worked out once, not once per kind; and a plan's distinct sessions are kept once worked
 * out. Local Node CPU medians (M1 Pro, shared and loaded), before → after:
 * overview 'all' 377–430 → 217–228, strength 'all' 390–433 → 214–227 (109 queries → 24),
 * strength 12w 216–253 → 124–133.
 */
import { gzipSync } from 'node:zlib';
import { stringify } from 'devalue';

/** Decision (m6-plan): the server time a page load aims for, reported. */
export const PAGE_TARGET_MS = 150;
/** Decision (m6-plan): the median above which db:explain fails. */
export const PAGE_LIMIT_MS = 300;
/** Decision (m6-plan): the most page data a Progress or review page sends, gzipped. */
export const PAGE_DATA_LIMIT_BYTES = 32 * 1024;
/** Decision (m6-plan): the untimed runs first, then the timed ones. */
export const WARM_UPS = 3;
export const TIMED_RUNS = 15;

/** The value at percentile `p` (0 to 100) of `values`, by nearest rank. */
export function percentile(values: readonly number[], p: number): number {
	if (values.length === 0) throw new RangeError('no values');
	const sorted = values.toSorted((a, b) => a - b);
	const rank = Math.ceil((p / 100) * sorted.length);
	return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}

/** The middle value, or the mean of the two middle ones. */
export function median(values: readonly number[]): number {
	if (values.length === 0) throw new RangeError('no values');
	const sorted = values.toSorted((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface PageData {
	/** devalue's string, in bytes. */
	raw: number;
	/** The same, gzipped. */
	gzip: number;
}

/** The page data `data` sends: devalue's string, and its size raw and gzipped. */
export function serialise(data: unknown): { text: string; size: PageData } {
	const text = stringify(data);
	const raw = Buffer.byteLength(text);
	return { text, size: { raw, gzip: gzipSync(text).byteLength } };
}

export interface LoadTiming {
	median: number;
	p95: number;
	/** Every timed run, in ms, in run order. */
	runs: number[];
	size: PageData;
}

/** `load` WARM_UPS times untimed, then `timed` times, each followed by its serialisation. */
export async function timeLoad(
	load: () => Promise<unknown>,
	{ warmUps = WARM_UPS, timed = TIMED_RUNS }: { warmUps?: number; timed?: number } = {}
): Promise<LoadTiming> {
	let size: PageData | undefined;
	const runs: number[] = [];
	for (let run = 0; run < warmUps + timed; run++) {
		const started = performance.now();
		size = serialise(await load()).size;
		const took = performance.now() - started;
		if (run >= warmUps) runs.push(took);
	}
	if (!size || runs.length === 0) throw new RangeError('no timed run');
	return { median: median(runs), p95: percentile(runs, 95), runs, size };
}

/** What is wrong with a load's timing, in words; empty when it passes. */
export function loadProblems({
	median: middle,
	size
}: Pick<LoadTiming, 'median' | 'size'>): string[] {
	return [
		...(middle > PAGE_LIMIT_MS
			? [`median ${middle.toFixed(1)} ms is over ${PAGE_LIMIT_MS} ms`]
			: []),
		...(size.gzip > PAGE_DATA_LIMIT_BYTES
			? [`page data ${size.gzip} B gzip is over ${PAGE_DATA_LIMIT_BYTES} B`]
			: [])
	];
}

/** Bytes as KB of 1,024 B with one decimal, as pnpm budgets reports them. */
export const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
