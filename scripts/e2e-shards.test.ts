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
	filesUnder,
	globMatcher,
	LEG_PROJECTS,
	legEntries,
	legKeys,
	legWorkers,
	listLine,
	planLeg,
	planShards,
	SHARD_ONE_FILES,
	SHARD_ONE_SHARE,
	shardArgs,
	shardCost,
	testCalls,
	type ShardEntry
} from './e2e-shards.ts';
import { LEGS } from '../e2e/projects.ts';
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

/** The file of a `<project> › <file>` key. */
const fileOf = (key: string) => key.slice(key.indexOf(' › ') + 3);

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
		// shard 1 is seeded last
		expect(planShards(equal, 2, 2, noneFirst).map((s) => s.keys)).toEqual([
			['p › f1.e2e.ts'],
			['p › f0.e2e.ts']
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
			const list = planLeg(`${group}/${engine}`, table.legs[`${group}/${engine}`]!);
			const workers = legWorkers(group, engine);
			const plan = planShards(list, of, workers);
			const [one, ...rest] = plan.map((s) => shardCost(s, workers));
			// Shard 1 must hold SHARD_ONE_FILES. When those alone outweigh an even split
			// (main/chromium in 3), no plan makes it the lightest: then it holds nothing else and
			// is the lightest at its planned share.
			const pinnedOnly = plan[0]!.keys.every((key) => SHARD_ONE_FILES.includes(fileOf(key)));
			const share = pinnedOnly ? SHARD_ONE_SHARE : 1;
			for (const other of rest) expect(one! * share, `${group}/${engine}`).toBeLessThan(other);
		}
	});

	it('leaves shard 1 its SHARD_ONE_FILES alone when they outweigh the others', () => {
		const pinned = [
			{ key: 'p › a11y-dark.e2e.ts', seconds: 100 },
			{ key: 'p › a11y-light.e2e.ts', seconds: 100 }
		];
		const others = Array.from({ length: 6 }, (_, i) => ({ key: `p › f${i}.e2e.ts`, seconds: 64 }));
		const [first, ...rest] = planShards([...pinned, ...others], 3, 2);
		// 200 s over 2 workers costs 100; the others' 384 s split into 96 each, none in shard 1
		expect(first!.keys).toEqual(pinned.map((e) => e.key));
		expect(shardCost(first!, 2)).toBe(100);
		expect(rest.map((shard) => shardCost(shard, 2))).toEqual([96, 96]);
	});

	it('breaks ties on the lighter shard, then the lower index', () => {
		const keyed = (seconds: number[]) =>
			seconds.map((s, i) => ({ key: `p › f${i}.e2e.ts`, seconds: s }));
		const plan = (seconds: number[], of: number, workers: number) =>
			planShards(keyed(seconds), of, workers, noneFirst).map((s) =>
				s.keys.map((k) => k.slice(4, -7))
			);
		// f5 (20 s) costs 40 after it in shard 2 or 3; shard 3 (cost 30) is lighter than 2 (40)
		expect(plan([40, 30, 30, 30, 30, 20], 3, 2)).toEqual([
			['f2', 'f4'],
			['f0'],
			['f1', 'f3', 'f5']
		]);
		// the 5 s file costs 15 in shard 2 or 3 at the same cost now: shard 2
		expect(plan([10, 10, 10, 5], 3, 1)).toEqual([['f2'], ['f0', 'f3'], ['f1']]);
	});

	it('seeds shard 1 last, so a file longer than an even split never makes it the heaviest', () => {
		// alone/chromium's perf.e2e.ts (140 s) outweighs a third of the leg (~133 s): seeded
		// first, it would have been shard 1's alone, and shard 1 the heaviest
		const leg = [150, 73, 55, 37, 34, 28, 21, 7].map((seconds, i) => ({
			key: `perf › f${i}.e2e.ts`,
			seconds
		}));
		const plan = planShards(leg, 3, 1, noneFirst);
		expect(plan[1]!.keys).toEqual(['perf › f0.e2e.ts']);
		const [one, ...rest] = plan.map((shard) => shardCost(shard, 1));
		for (const other of rest) expect(one).toBeLessThan(other);
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
	const leg: ShardEntry[] = [
		{ key: 'desktop-chromium › a.e2e.ts', seconds: 50 },
		{ key: 'desktop-chromium › b.e2e.ts', seconds: 40 },
		{ key: 'iphone-chromium › c.e2e.ts', seconds: 30 },
		{ key: 'iphone-chromium › d.e2e.ts', seconds: 20 }
	];

	it('writes `[<project>] › <file>` lines', () => {
		expect(listLine('desktop-chromium › screens.desktop.e2e.ts')).toBe(
			'[desktop-chromium] › screens.desktop.e2e.ts'
		);
		expect(() => listLine('screens.desktop.e2e.ts')).toThrow(/not a <project> › <file> key/);
	});

	it('gives shards 2..n their own files and shard 1 the inverse of their union', () => {
		const at = (current: number) =>
			shardArgs(leg, { current, total: 3, workers: 1, listFile: 'list.txt' });
		const plan = planShards(leg, 3, 1);
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

	it('gives every CI leg as many Playwright workers as the config does', async () => {
		for (const { group, engine } of LEGS) {
			vi.resetModules();
			vi.stubEnv('CI', '1');
			vi.stubEnv('E2E_GROUP', group);
			vi.stubEnv('E2E_ENGINE', engine);
			const { default: config } = await import('../playwright.config.ts');
			expect(config.workers, `${group}/${engine}`).toBe(legWorkers(group, engine));
		}
	});
	afterEach(() => vi.unstubAllEnvs());
});

describe('the leg’s spec files', () => {
	it('matches a `**/<name>` glob against the file name at any depth', () => {
		const serial = globMatcher('**/*.serial.e2e.ts');
		expect(serial('plan.serial.e2e.ts')).toBe(true);
		expect(serial('smoke/plan.serial.e2e.ts')).toBe(true);
		expect(serial('plan.serial.e2e.ts.bak')).toBe(false);
		expect(serial('planXserial.e2e.ts')).toBe(false);
		const perf = globMatcher('**/perf-*.e2e.ts');
		expect(perf('perf-coach.e2e.ts')).toBe(true);
		expect(perf('perf.e2e.ts')).toBe(false);
		expect(globMatcher('**/shell.e2e.ts')('workout-shell.e2e.ts')).toBe(false);
		expect(() => globMatcher('e2e/*.e2e.ts')).toThrow(/unsupported glob/);
		expect(() => globMatcher('**/smoke/*.e2e.ts')).toThrow(/unsupported glob/);
	});

	it('lists each project’s matched, unignored files', () => {
		const files = [
			'a11y-dark.e2e.ts',
			'a11y-suite.ts',
			'home.e2e.ts',
			'home.desktop.e2e.ts',
			'perf.e2e.ts',
			'perf-coach.e2e.ts',
			'plan.serial.e2e.ts',
			'sessions.exclusive.e2e.ts',
			'shell.e2e.ts',
			'smoke/health.smoke.e2e.ts'
		];
		expect(legKeys(LEG_PROJECTS['main/chromium']!, files)).toEqual([
			'iphone-chromium › a11y-dark.e2e.ts',
			'iphone-chromium › home.e2e.ts',
			'iphone-chromium › shell.e2e.ts',
			'iphone-chromium › smoke/health.smoke.e2e.ts',
			'desktop-chromium › a11y-dark.e2e.ts',
			'desktop-chromium › home.desktop.e2e.ts',
			'desktop-chromium › shell.e2e.ts',
			'desktop-chromium › smoke/health.smoke.e2e.ts'
		]);
		expect(legKeys(LEG_PROJECTS['serial/webkit']!, files)).toEqual([
			'serial-webkit › plan.serial.e2e.ts'
		]);
		expect(legKeys(LEG_PROJECTS['alone/chromium']!, files)).toEqual([
			'perf › perf.e2e.ts',
			'perf › perf-coach.e2e.ts'
		]);
		expect(legKeys(LEG_PROJECTS['exclusive/chromium']!, files)).toEqual([
			'exclusive › sessions.exclusive.e2e.ts'
		]);
	});

	it('finds the spec files under a folder, nested ones by their relative path', () => {
		const dir = path.join(root, 'e2e');
		const files = filesUnder(dir);
		expect(files).toContain('smoke/health.smoke.e2e.ts');
		expect(files).toContain('a11y-dark.e2e.ts');
		expect(files).toEqual([...files].sort());
	});

	it('counts a file’s own test( calls, not describe, step or use', () => {
		const source = [
			"test.use({ serviceWorkers: 'block' });",
			"test.describe('a', () => {",
			"\ttest('one', async () => { await test.step('s', () => {}); });",
			"\ttest ('two', async () => {});",
			"\tlatest('not a test');",
			'});'
		].join('\n');
		expect(testCalls(source)).toBe(2);
		expect(testCalls("runA11ySuite('dark');")).toBe(0);
	});

	it('estimates an untimed file from its test calls, at the leg’s seconds per call', () => {
		const calls: Record<string, number> = { 'a.e2e.ts': 2, 'b.e2e.ts': 4, 'c.e2e.ts': 3 };
		const entries = legEntries(
			['p › a.e2e.ts', 'p › b.e2e.ts', 'p › c.e2e.ts', 'p › suite.e2e.ts'],
			{ 'p › a.e2e.ts': 20, 'p › b.e2e.ts': 40, 'p › gone.e2e.ts': 500 },
			(file) => calls[file] ?? 0
		);
		// 60 s over 6 calls: 10 s a call; suite.e2e.ts has none of its own, so the median file
		expect(entries).toEqual([
			{ key: 'p › a.e2e.ts', seconds: 20 },
			{ key: 'p › b.e2e.ts', seconds: 40 },
			{ key: 'p › c.e2e.ts', seconds: 30 },
			{ key: 'p › suite.e2e.ts', seconds: 30 }
		]);
	});

	it('plans untimed files across the shards, not all into shard 1', () => {
		const timed = Object.fromEntries(
			Array.from({ length: 8 }, (_, i) => [`p › t${i}.e2e.ts`, 60] as const)
		);
		const untimed = Array.from({ length: 8 }, (_, i) => `p › new${i}.e2e.ts`);
		const entries = legEntries([...Object.keys(timed), ...untimed], timed, () => 1);
		const at = (current: number) =>
			shardArgs(entries, { current, total: 4, workers: 1, listFile: 'list.txt' });
		const placed = [2, 3, 4].map((current) =>
			at(current).lines.filter((line) => line.includes('new'))
		);
		for (const lines of placed) expect(lines.length).toBeGreaterThan(0);
		// shard 1 runs by inversion: the untimed files it does not list are its own
		const elsewhere = new Set(placed.flat());
		expect(
			at(1)
				.lines.filter((line) => line.includes('new'))
				.sort()
		).toEqual([...elsewhere].sort());
		expect(elsewhere.size).toBeLessThan(untimed.length);
	});

	it('plans every spec file of each CI leg, the ones the table lacks too', () => {
		for (const { group, engine, of } of ciShardedLegs()) {
			const leg = `${group}/${engine}`;
			const keys = legKeys(LEG_PROJECTS[leg]!, filesUnder(path.join(root, 'e2e')));
			const entries = planLeg(leg, table.legs[leg]!);
			expect(entries.map((e) => e.key)).toEqual(keys);
			for (const entry of entries.filter((e) => !(e.key in table.legs[leg]!))) {
				expect(entry.seconds, `${entry.key}, untimed`).toBeGreaterThan(0);
			}
			const planned = planShards(entries, of, legWorkers(group, engine)).flatMap((s) => s.keys);
			expect(planned.sort()).toEqual([...keys].sort());
		}
	});
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
		const expected = shardArgs(planLeg('serial/webkit', table.legs['serial/webkit']!), {
			current: 2,
			total: 4,
			workers: legWorkers('serial', 'webkit'),
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
		const alone = cli({ E2E_GROUP: 'exclusive', E2E_ENGINE: 'chromium', E2E_SHARD: '1/1' }, file);
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
