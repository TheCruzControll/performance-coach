/**
 * `node scripts/e2e-shards.ts <list-file>`: which spec files this CI shard runs, planned from the
 * measured seconds in e2e/timings.json, as Playwright arguments (.github/workflows/ci.yml).
 *
 * planShards splits a leg's `<project> › <file>` entries into shards, longest first, each into the
 * shard it leaves cheapest. A shard's cost is its wall clock with the leg's workers (2 in main, 1
 * elsewhere, playwright.config.ts): its summed seconds over the workers, but never less than its
 * largest file. Shard 1 is planned 10% lighter, because it also runs every file the table lacks.
 *
 * The CLI reads E2E_GROUP, E2E_ENGINE and E2E_SHARD (`<current>/<total>`) and writes the shard's
 * files to <list-file> as `[<project>] › <file>` lines, paths relative to e2e/ (Playwright's
 * rootDir). Shards 2..n print `--test-list <list-file>`; shard 1 lists the union of shards 2..n and
 * prints `--test-list-invert <list-file>`, so it runs everything else: a file missing from the
 * table runs in shard 1, never nowhere, and a stale line matches nothing on either side. With one
 * shard, or no E2E_SHARD (a local run), it prints nothing. Playwright filters only top-level
 * projects by the list: the setup projects run in full in every shard.
 *
 * Playwright matches a list line against the file that declares each test. The axe specs only
 * call a suite their module declares (e2e/a11y-suite.ts), so no list line can select them: they
 * are planned into shard 1, which runs them by inversion (SHARD_ONE_FILES). The listing test
 * (scripts/e2e-shards.listing.test.ts) fails if another such file is planned elsewhere.
 *
 * Node builtins and the timing table only, so CI runs it before anything else is built.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** One `<project> › <file>` of a leg and its measured seconds. */
export interface ShardEntry {
	key: string;
	seconds: number;
}

/** A planned shard: its entries' keys, their summed seconds and the largest one. */
export interface PlannedShard {
	keys: string[];
	seconds: number;
	largest: number;
}

/** Shard 1's planned share of an ordinary shard's cost: it also runs the untimed files. */
export const SHARD_ONE_SHARE = 0.9;

/**
 * Spec files whose tests a module they import declares, which no `--test-list` line can select:
 * they stay in shard 1, the inverted list.
 */
export const SHARD_ONE_FILES: readonly string[] = ['a11y-dark.e2e.ts', 'a11y-light.e2e.ts'];

/** Playwright workers a CI leg of `group` runs (playwright.config.ts). */
export const legWorkers = (group: string) => (group === 'main' ? 2 : 1);

/** A shard's planned wall clock: its seconds over the workers, at least its largest file. */
export const shardCost = (shard: PlannedShard, workers: number) =>
	Math.max(shard.largest, shard.seconds / workers);

/** The file of a `<project> › <file>` key. */
const fileOf = (key: string) => key.slice(key.indexOf(' › ') + 3);

const longestFirst = (a: ShardEntry, b: ShardEntry) =>
	b.seconds - a.seconds || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * Splits `entries` into `of` shards (index 0 is shard 1). `shardOne` entries go to shard 1 first;
 * then, longest first, an empty shard takes the next entry (the lowest index first), and otherwise
 * the entry goes to the shard whose cost after it is lowest, shard 1's cost counted at
 * 1 / SHARD_ONE_SHARE; ties go to the lighter shard, then the lower index.
 */
export function planShards(
	entries: readonly ShardEntry[],
	of: number,
	workers: number,
	shardOne: (key: string) => boolean = (key) => SHARD_ONE_FILES.includes(fileOf(key))
): PlannedShard[] {
	if (!Number.isInteger(of) || of < 1) throw new Error(`shard count ${of}: expected 1 or more`);
	if (entries.length < of) {
		throw new Error(`${entries.length} files cannot fill ${of} shards`);
	}
	const shards: PlannedShard[] = Array.from({ length: of }, () => ({
		keys: [],
		seconds: 0,
		largest: 0
	}));
	const add = (shard: PlannedShard, entry: ShardEntry) => {
		shard.keys.push(entry.key);
		shard.seconds += entry.seconds;
		shard.largest = Math.max(shard.largest, entry.seconds);
	};
	const weighted = (index: number, cost: number) => (index === 0 ? cost / SHARD_ONE_SHARE : cost);
	const sorted = [...entries].sort(longestFirst);
	for (const entry of sorted.filter((e) => shardOne(e.key))) add(shards[0]!, entry);
	for (const entry of sorted.filter((e) => !shardOne(e.key))) {
		const empty = shards.findIndex((s) => s.keys.length === 0);
		if (empty !== -1) {
			add(shards[empty]!, entry);
			continue;
		}
		let best = 0;
		let bestAfter = Infinity;
		let bestNow = Infinity;
		shards.forEach((shard, index) => {
			const now = weighted(index, shardCost(shard, workers));
			const after = weighted(
				index,
				shardCost(
					{
						keys: shard.keys,
						seconds: shard.seconds + entry.seconds,
						largest: Math.max(shard.largest, entry.seconds)
					},
					workers
				)
			);
			if (after < bestAfter || (after === bestAfter && now < bestNow)) {
				[best, bestAfter, bestNow] = [index, after, now];
			}
		});
		add(shards[best]!, entry);
	}
	return shards;
}

/** A `<project> › <file>` key as a `--test-list` line: `[<project>] › <file>`. */
export function listLine(key: string): string {
	const at = key.indexOf(' › ');
	if (at <= 0) throw new Error(`not a <project> › <file> key: ${key}`);
	return `[${key.slice(0, at)}] › ${key.slice(at + 3)}`;
}

export interface ShardArgs {
	/** The list file's lines, empty when no list is needed. */
	lines: string[];
	/** The Playwright arguments, with `listFile` in place. */
	args: string[];
}

/**
 * What shard `current` of `total` runs from a leg's timing table entries: shard 1 the inverse of
 * shards 2..n's union, any other shard its own files; one shard runs the whole leg.
 */
export function shardArgs(
	seconds: Record<string, number>,
	{
		current,
		total,
		workers,
		listFile
	}: { current: number; total: number; workers: number; listFile: string }
): ShardArgs {
	if (total === 1) return { lines: [], args: [] };
	const entries = Object.entries(seconds).map(([key, s]) => ({ key, seconds: s }));
	const shards = planShards(entries, total, workers);
	if (current === 1) {
		const lines = shards
			.slice(1)
			.flatMap((s) => s.keys)
			.sort()
			.map(listLine);
		return { lines, args: ['--test-list-invert', listFile] };
	}
	return {
		lines: [...shards[current - 1]!.keys].sort().map(listLine),
		args: ['--test-list', listFile]
	};
}

/** The committed timing table. */
const TIMINGS = fileURLToPath(new URL('../e2e/timings.json', import.meta.url));

function main(): void {
	const listFile = process.argv[2];
	if (!listFile) throw new Error('usage: node scripts/e2e-shards.ts <list-file>');
	const { E2E_GROUP: group, E2E_ENGINE: engine, E2E_SHARD: shard } = process.env;
	if (!shard) return;
	const match = /^(\d+)\/(\d+)$/.exec(shard);
	const [current, total] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
	if (current < 1 || current > total) throw new Error(`E2E_SHARD=${shard}: expected <n>/<of>`);
	if (total === 1) return;
	if (!group || !engine) throw new Error('E2E_GROUP and E2E_ENGINE name the leg to shard');
	const table = JSON.parse(readFileSync(TIMINGS, 'utf8')) as {
		legs: Record<string, Record<string, number>>;
	};
	const leg = table.legs[`${group}/${engine}`];
	if (!leg) throw new Error(`e2e/timings.json has no ${group}/${engine} leg to shard`);
	const { lines, args } = shardArgs(leg, { current, total, workers: legWorkers(group), listFile });
	writeFileSync(listFile, `${lines.join('\n')}\n`);
	console.log(args.join(' '));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
