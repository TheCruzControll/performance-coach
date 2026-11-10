/**
 * scripts/e2e-shards.ts: each CI shard's spec files, planned from e2e/timings.json, and the
 * `--test-list` arguments that run them. The listings of every CI shard are in
 * scripts/e2e-shards.listing.test.ts.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
	legWorkers,
	listLine,
	planShards,
	SHARD_ONE_FILES,
	SHARD_ONE_SHARE,
	shardArgs,
	shardCost,
	type ShardEntry
} from './e2e-shards.ts';
import { ciShardedLegs, fileKey, inPool, listRuns } from './lib/playwright-list.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const table = JSON.parse(readFileSync(path.join(root, 'e2e/timings.json'), 'utf8')) as {
	legs: Record<string, Record<string, number>>;
};
const scratch = mkdtempSync(path.join(tmpdir(), 'e2e-shards-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A deterministic pseudo-random sequence in [0, 1). */
function random(seed: number) {
	let state = seed;
	return () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
}

/** `count` entries with seeded seconds, from 0 to 100 in half seconds. */
function entries(count: number, seed: number): ShardEntry[] {
	const next = random(seed);
	return Array.from({ length: count }, (_, i) => ({
		key: `p${i % 3} › f${i}.e2e.ts`,
		seconds: Math.round(next() * 200) / 2
	}));
}

const noneFirst = () => false;

/** Seeded cases: shard counts 1-5, 1 or 2 workers, up to 30 more entries than shards. */
const cases = Array.from({ length: 300 }, (_, i) => {
	const next = random(1000 + i);
	const of = 1 + Math.floor(next() * 5);
	const workers = 1 + Math.floor(next() * 2);
	return { of, workers, entries: entries(of + Math.floor(next() * 30), i) };
});

describe('planShards', () => {
	it('puts every entry in exactly one shard', () => {
		for (const { of, workers, entries: list } of cases) {
			const shards = planShards(list, of, workers, noneFirst);
			expect(shards).toHaveLength(of);
			expect(shards.flatMap((s) => s.keys).sort()).toEqual(list.map((e) => e.key).sort());
			for (const shard of shards) {
				const mine = list.filter((e) => shard.keys.includes(e.key));
				expect(shard.seconds).toBeCloseTo(
					mine.reduce((sum, e) => sum + e.seconds, 0),
					6
				);
				expect(shard.largest).toBe(Math.max(...mine.map((e) => e.seconds)));
			}
		}
	});

	it('plans the same shards whatever order the entries come in', () => {
		for (const { of, workers, entries: list } of cases.slice(0, 50)) {
			const shuffled = [...list].sort(() => (random(of)() < 0.5 ? -1 : 1)).reverse();
			expect(planShards(shuffled, of, workers, noneFirst)).toEqual(
				planShards(list, of, workers, noneFirst)
			);
		}
	});

	it('leaves no shard empty, even with equal entries', () => {
		for (const { of, workers, entries: list } of cases) {
			for (const shard of planShards(list, of, workers, noneFirst)) {
				expect(shard.keys.length).toBeGreaterThan(0);
			}
		}
		const equal = [10, 10].map((seconds, i) => ({ key: `p › f${i}.e2e.ts`, seconds }));
		expect(planShards(equal, 2, 2, noneFirst).map((s) => s.keys)).toEqual([
			['p › f0.e2e.ts'],
			['p › f1.e2e.ts']
		]);
		expect(() => planShards(equal, 3, 1)).toThrow(/2 files cannot fill 3 shards/);
		expect(() => planShards(equal, 0, 1)).toThrow(/shard count 0/);
	});

	it('keeps the heaviest shard within the mean plus the largest entry', () => {
		for (const { of, workers, entries: list } of cases) {
			const shards = planShards(list, of, workers, noneFirst);
			const total = list.reduce((sum, e) => sum + e.seconds, 0);
			const largest = Math.max(...list.map((e) => e.seconds));
			const heaviest = Math.max(...shards.map((s) => shardCost(s, workers)));
			expect(heaviest).toBeLessThanOrEqual(total / of / workers + largest + 1e-9);
		}
	});

	it('costs a shard its seconds over the workers, never less than its largest file', () => {
		expect(shardCost({ keys: [], seconds: 100, largest: 30 }, 2)).toBe(50);
		expect(shardCost({ keys: [], seconds: 100, largest: 80 }, 2)).toBe(80);
		expect(shardCost({ keys: [], seconds: 100, largest: 30 }, 1)).toBe(100);
	});

	it('plans shard 1 about 10% lighter than the others', () => {
		const ones = Array.from({ length: 100 }, (_, i) => ({ key: `p › f${i}.e2e.ts`, seconds: 1 }));
		const [first, second] = planShards(ones, 2, 1, noneFirst);
		// balanced where first / 0.9 = second: 47.4 of 100
		expect(first!.seconds).toBe(47);
		expect(second!.seconds).toBe(53);
		expect(SHARD_ONE_SHARE).toBe(0.9);
		const legs = ciShardedLegs();
		expect(legs.length).toBeGreaterThan(0);
		for (const { group, engine, of } of legs) {
			const seconds = table.legs[`${group}/${engine}`]!;
			const list = Object.entries(seconds).map(([key, s]) => ({ key, seconds: s }));
			const workers = legWorkers(group);
			const [one, ...rest] = planShards(list, of, workers).map((s) => shardCost(s, workers));
			for (const other of rest) expect(one, `${group}/${engine}`).toBeLessThan(other);
		}
	});

	it('breaks ties on the lighter shard, then the lower index', () => {
		const keyed = (seconds: number[]) =>
			seconds.map((s, i) => ({ key: `p › f${i}.e2e.ts`, seconds: s }));
		const plan = (seconds: number[], of: number, workers: number) =>
			planShards(keyed(seconds), of, workers, noneFirst).map((s) =>
				s.keys.map((k) => k.slice(4, -7))
			);
		// f1 (10 s) costs 20 after it in shard 2 or 3; shard 3 (cost 15) is lighter than 2 (20)
		expect(plan([20, 10, 40, 10, 30, 40, 20, 30], 3, 2)).toEqual([
			['f2'],
			['f5', 'f6', 'f1', 'f3'],
			['f4', 'f7', 'f0']
		]);
		// the 5 s file costs 15 in shard 2 or 3 at the same cost now: shard 2
		expect(plan([10, 10, 10, 5], 3, 1)).toEqual([['f0'], ['f1', 'f3'], ['f2']]);
	});

	it('plans the files a module declares tests for into shard 1', () => {
		const list = [
			{ key: 'iphone-webkit › a11y-dark.e2e.ts', seconds: 199 },
			{ key: 'iphone-webkit › a11y-light.e2e.ts', seconds: 195 },
			...Array.from({ length: 10 }, (_, i) => ({
				key: `iphone-webkit › f${i}.e2e.ts`,
				seconds: 80
			}))
		];
		const [first, ...rest] = planShards(list, 3, 2);
		expect(first!.keys.slice(0, 2)).toEqual([
			'iphone-webkit › a11y-dark.e2e.ts',
			'iphone-webkit › a11y-light.e2e.ts'
		]);
		for (const shard of rest) expect(shard.keys.join()).not.toMatch(/a11y/);
		expect(SHARD_ONE_FILES).toEqual(['a11y-dark.e2e.ts', 'a11y-light.e2e.ts']);
	});
});

describe('the shard arguments', () => {
	const leg = {
		'desktop-chromium › a.e2e.ts': 50,
		'desktop-chromium › b.e2e.ts': 40,
		'iphone-chromium › c.e2e.ts': 30,
		'iphone-chromium › d.e2e.ts': 20
	};

	it('writes `[<project>] › <file>` lines', () => {
		expect(listLine('desktop-chromium › screens.desktop.e2e.ts')).toBe(
			'[desktop-chromium] › screens.desktop.e2e.ts'
		);
		expect(() => listLine('screens.desktop.e2e.ts')).toThrow(/not a <project> › <file> key/);
	});

	it('gives shards 2..n their own files and shard 1 the inverse of their union', () => {
		const at = (current: number) =>
			shardArgs(leg, { current, total: 3, workers: 1, listFile: 'list.txt' });
		const plan = planShards(
			Object.entries(leg).map(([key, seconds]) => ({ key, seconds })),
			3,
			1
		);
		expect(at(2)).toEqual({
			lines: plan[1]!.keys.map(listLine),
			args: ['--test-list', 'list.txt']
		});
		expect(at(3)).toEqual({
			lines: plan[2]!.keys.map(listLine),
			args: ['--test-list', 'list.txt']
		});
		expect(at(1).args).toEqual(['--test-list-invert', 'list.txt']);
		expect(at(1).lines).toEqual([...at(2).lines, ...at(3).lines].sort());
		expect(shardArgs(leg, { current: 1, total: 1, workers: 1, listFile: 'x' })).toEqual({
			lines: [],
			args: []
		});
	});

	it('gives a CI leg as many Playwright workers as the config does', async () => {
		for (const group of ['main', 'serial', 'alone']) {
			vi.resetModules();
			vi.stubEnv('CI', '1');
			vi.stubEnv('E2E_GROUP', group);
			const { default: config } = await import('../playwright.config.ts');
			expect(config.workers, group).toBe(legWorkers(group));
		}
	});
	afterEach(() => vi.unstubAllEnvs());
});

/** The CLI as CI runs it. */
function cli(env: Record<string, string>, listFile: string) {
	const clean: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (!name.startsWith('E2E_')) clean[name] = value;
	}
	return spawnSync(process.execPath, ['scripts/e2e-shards.ts', listFile], {
		cwd: root,
		env: { ...clean, ...env },
		encoding: 'utf8'
	});
}

describe('the CLI', () => {
	it('prints the list argument and writes the shard’s lines from the timing table', () => {
		const file = path.join(scratch, 'two.txt');
		const run = cli({ E2E_GROUP: 'serial', E2E_ENGINE: 'webkit', E2E_SHARD: '2/4' }, file);
		expect(run.stderr).toBe('');
		expect(run.stdout).toBe(`--test-list ${file}\n`);
		const expected = shardArgs(table.legs['serial/webkit']!, {
			current: 2,
			total: 4,
			workers: 1,
			listFile: file
		});
		expect(readFileSync(file, 'utf8')).toBe(`${expected.lines.join('\n')}\n`);
		expect(expected.lines[0]).toMatch(/^\[serial-webkit\] › [\w.-]+\.serial\.e2e\.ts$/);

		const first = path.join(scratch, 'one.txt');
		const inverted = cli({ E2E_GROUP: 'main', E2E_ENGINE: 'chromium', E2E_SHARD: '1/2' }, first);
		expect(inverted.stdout).toBe(`--test-list-invert ${first}\n`);
		expect(readFileSync(first, 'utf8')).toMatch(/^\[(iphone|desktop)-chromium\] › /);
	});

	it('prints nothing and writes nothing for one shard or a local run', () => {
		const file = path.join(scratch, 'none.txt');
		const alone = cli({ E2E_GROUP: 'alone', E2E_ENGINE: 'chromium', E2E_SHARD: '1/1' }, file);
		expect([alone.status, alone.stdout]).toEqual([0, '']);
		const local = cli({}, file);
		expect([local.status, local.stdout]).toEqual([0, '']);
		expect(existsSync(file)).toBe(false);
	});

	it('fails on a malformed shard or a leg the table lacks', () => {
		const file = path.join(scratch, 'bad.txt');
		const bad = cli({ E2E_GROUP: 'main', E2E_ENGINE: 'chromium', E2E_SHARD: '3/2' }, file);
		expect(bad.status).not.toBe(0);
		expect(bad.stderr).toMatch(/E2E_SHARD=3\/2/);
		const missing = cli({ E2E_GROUP: 'sweeps', E2E_ENGINE: 'webkit', E2E_SHARD: '1/2' }, file);
		expect(missing.status).not.toBe(0);
		expect(missing.stderr).toMatch(/no sweeps\/webkit leg/);
	});
});

/**
 * Spec names that end another's: a list line names one file exactly, so listing one never lists
 * the other, in a list or inverted.
 */
const SUFFIX_PAIRS = [
	['desktop-chromium', 'screens.desktop.e2e.ts', 'main-screens.desktop.e2e.ts'],
	['iphone-chromium', 'shell.e2e.ts', 'workout-shell.e2e.ts'],
	['desktop-chromium', 'shell.desktop.e2e.ts', 'workout-shell.desktop.e2e.ts']
] as const;

describe('a list line, listed by Playwright', () => {
	it('selects exactly its file, never one its name ends', async () => {
		const leg = { group: 'main', engine: 'chromium' };
		const shorts = SUFFIX_PAIRS.map(([project, short]) => `${project} › ${short}`);
		const longs = SUFFIX_PAIRS.map(([project, , long]) => `${project} › ${long}`);
		/** The pairs' files listed with `flag` over a list of `keys`. */
		const listing = (name: string, keys: string[], flag: string) => {
			const list = path.join(scratch, `pairs-${name}.txt`);
			writeFileSync(list, `${keys.map(listLine).join('\n')}\n`);
			return async () => {
				const files = new Set((await listRuns(leg, [flag, list])).map(fileKey));
				return [...shorts, ...longs].filter((key) => files.has(key)).sort();
			};
		};
		const [shortsListed, longsListed, shortsInverted, longsInverted] = await inPool(
			[
				listing('shorts', shorts, '--test-list'),
				listing('longs', longs, '--test-list'),
				listing('shorts-inverted', shorts, '--test-list-invert'),
				listing('longs-inverted', longs, '--test-list-invert')
			],
			4
		);
		expect(shortsListed).toEqual([...shorts].sort());
		expect(longsListed).toEqual([...longs].sort());
		expect(shortsInverted).toEqual([...longs].sort());
		expect(longsInverted).toEqual([...shorts].sort());
	}, 120_000);
});
