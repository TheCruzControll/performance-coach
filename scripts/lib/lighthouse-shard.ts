/**
 * The --shard i/N option of scripts/lighthouse.ts. CI runs Lighthouse in N parallel jobs, each
 * auditing its share of the routes; the share is taken from the full route list (defaults or
 * --routes, then the seeded program screens), so a slice that adds a route changes nothing here.
 */

/** One shard of `count`: `index` runs from 1 to `count`. */
export interface Shard {
	index: number;
	count: number;
}

/** 'i/N' with 1 ≤ i ≤ N, as Playwright's --shard reads it; anything else throws. */
export function parseShard(text: string): Shard {
	const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(text.trim());
	const shard = match ? { index: Number(match[1]), count: Number(match[2]) } : undefined;
	if (!shard || shard.index > shard.count) {
		throw new Error(`--shard takes i/N with 1 ≤ i ≤ N (e.g. 1/2), not "${text}"`);
	}
	return shard;
}

/**
 * The URLs shard `index` of `count` audits: the k-th URL (from 0) goes to shard (k mod count) + 1,
 * so every URL is in exactly one shard, each keeps the list's order, and sizes differ by at most one.
 */
export function shardUrls<T>(urls: readonly T[], index: number, count: number): T[] {
	if (!Number.isInteger(index) || !Number.isInteger(count) || index < 1 || index > count) {
		throw new Error(`--shard ${index}/${count} is not a shard`);
	}
	return urls.filter((_, k) => k % count === index - 1);
}

/** Where a shard writes its reports: today's directory when unsharded, else one per form factor. */
export function shardReportDir(unsharded: string, formFactor: string, shard: Shard): string {
	return shard.count === 1 ? unsharded : `lighthouse-reports/${formFactor}/shard-${shard.index}`;
}
