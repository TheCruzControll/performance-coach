/**
 * Every sharded CI leg, listed by Playwright with exactly the arguments each shard gets from
 * scripts/e2e-shards.ts: the shards split the leg's tests between them (each test in exactly one
 * shard, none left out) and each runs the full setup, also when half the leg's files are missing
 * from the timing table. Every CI leg's spec files, as the planner reads them from disk, are the
 * ones Playwright lists. A file of its own, so Vitest lists these legs beside
 * scripts/e2e-projects.test.ts's.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { legWorkers, planLeg, planShards, shardArgs as plannedArgs } from './e2e-shards.ts';
import {
	ciLegs,
	ciShardedLegs,
	fileKey,
	inPool,
	isSetupRun,
	listRuns
} from './lib/playwright-list.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), 'e2e-shards-listing-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const legs = ciShardedLegs();
const table = JSON.parse(readFileSync(path.join(root, 'e2e/timings.json'), 'utf8')) as {
	legs: Record<string, Record<string, number>>;
};

/** The arguments the Playwright step adds for one shard, from the CLI as CI runs it. */
function shardArgs(leg: { group: string; engine: string }, shard: string): string[] {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (!name.startsWith('E2E_')) env[name] = value;
	}
	const list = path.join(scratch, `${leg.group}-${leg.engine}-${shard.replace('/', '-of-')}.txt`);
	const run = spawnSync(process.execPath, ['scripts/e2e-shards.ts', list], {
		cwd: root,
		env: { ...env, E2E_GROUP: leg.group, E2E_ENGINE: leg.engine, E2E_SHARD: shard },
		encoding: 'utf8'
	});
	if (run.status !== 0) throw new Error(`e2e-shards ${shard} failed: ${run.stderr}`);
	return run.stdout.trim().split(/\s+/).filter(Boolean);
}

/**
 * The leg's timing table with every other file (sorted) dropped: the files a table that predates
 * them lacks.
 */
function halfTimed(leg: string): { timed: Record<string, number>; untimed: string[] } {
	const keys = planLeg(leg, table.legs[leg]!)
		.map((e) => e.key)
		.sort();
	const untimed = keys.filter((_, i) => i % 2 === 1);
	const timed = Object.fromEntries(
		Object.entries(table.legs[leg]!).filter(([key]) => !untimed.includes(key))
	);
	return { timed, untimed };
}

/** Shard `current`'s arguments planned from `timed`, its list written beside the CLI's. */
function halfTimedArgs(leg: { group: string; engine: string; of: number }, current: number) {
	const name = `${leg.group}/${leg.engine}`;
	const listFile = path.join(scratch, `half-${leg.group}-${leg.engine}-${current}.txt`);
	const { lines, args } = plannedArgs(planLeg(name, halfTimed(name).timed), {
		current,
		total: leg.of,
		workers: legWorkers(leg.group, leg.engine),
		listFile
	});
	writeFileSync(listFile, `${lines.join('\n')}\n`);
	return args;
}

/** Per leg: its own listing and each shard's, in shard order, from the table and half of it. */
const listings = new Map<string, { whole: string[]; shards: string[][]; half: string[][] }>();
/** Every CI leg's listing, the unsharded too. */
const everyLeg = ciLegs();
const wholes = new Map<string, string[]>();

beforeAll(async () => {
	const tasks = [
		...legs.flatMap((leg) => [
			...Array.from({ length: leg.of }, (_, i) => {
				const args = shardArgs(leg, `${i + 1}/${leg.of}`);
				return () => listRuns(leg, args);
			}),
			...Array.from({ length: leg.of }, (_, i) => {
				const args = halfTimedArgs(leg, i + 1);
				return () => listRuns(leg, args);
			})
		]),
		...everyLeg.map((leg) => () => listRuns(leg))
	];
	const results = await inPool(tasks, 4);
	let at = 0;
	const perLeg = legs.map((leg) => {
		const shards = results.slice(at, at + leg.of);
		const half = results.slice(at + leg.of, at + 2 * leg.of);
		at += 2 * leg.of;
		return { shards, half };
	});
	everyLeg.forEach((leg) => wholes.set(`${leg.group}/${leg.engine}`, results[at++]!));
	legs.forEach((leg, i) => {
		const name = `${leg.group}/${leg.engine}`;
		listings.set(name, { whole: wholes.get(name)!, ...perLeg[i]! });
	});
}, 300_000);

const files = (runs: string[]) => [...new Set(runs.filter((r) => !isSetupRun(r)).map(fileKey))];

describe('every CI leg’s spec files', () => {
	it.each(everyLeg)('$group/$engine: the planner reads the files Playwright lists', (leg) => {
		const name = `${leg.group}/${leg.engine}`;
		const planned = planLeg(name, table.legs[name] ?? {}).map((e) => e.key);
		expect(planned.sort()).toEqual(files(wholes.get(name)!).sort());
	});
});

/** Checks one leg's shard listings against the plan they were given. */
function expectShards(whole: string[], shards: string[][], plan: { keys: string[] }[]) {
	const setup = (runs: string[]) => runs.filter(isSetupRun).sort();
	const functional = (runs: string[]) => runs.filter((r) => !isSetupRun(r));
	expect(functional(whole).length).toBeGreaterThan(0);
	shards.forEach((shard, i) => {
		expect(functional(shard).length, `shard ${i + 1} runs tests`).toBeGreaterThan(0);
		expect(setup(shard), `shard ${i + 1} runs the setup`).toEqual(setup(whole));
		// A file whose tests a module declares cannot be listed (scripts/e2e-shards.ts
		// SHARD_ONE_FILES): planned into shard 2..n it would silently move to shard 1.
		expect(files(shard).sort(), `shard ${i + 1} runs its planned files`).toEqual(
			[...plan[i]!.keys].sort()
		);
	});
	expect(shards.flatMap(functional).sort()).toEqual(functional(whole).sort());
}

describe('the sharded legs, listed by Playwright with each shard’s list', () => {
	it('find the sharded legs in ci.yml', () => {
		expect(legs.length).toBeGreaterThan(0);
	});

	it.each(legs)(
		'$group/$engine in $of shards: each test in exactly one, the setup in all',
		({ group, engine, of }) => {
			const name = `${group}/${engine}`;
			const { whole, shards } = listings.get(name)!;
			expectShards(
				whole,
				shards,
				planShards(planLeg(name, table.legs[name]!), of, legWorkers(group, engine))
			);
		}
	);

	// Spec files merged after the table was measured: planned across the shards with explicit
	// list lines, not all left to shard 1's inversion.
	it.each(legs)(
		'$group/$engine with half its files untimed: they run on the shards planned for them',
		({ group, engine, of }) => {
			const name = `${group}/${engine}`;
			const { whole, half } = listings.get(name)!;
			const { timed, untimed } = halfTimed(name);
			const plan = planShards(planLeg(name, timed), of, legWorkers(group, engine));
			expectShards(whole, half, plan);
			const elsewhere = half.slice(1).flatMap(files);
			expect(elsewhere.filter((key) => untimed.includes(key)).length).toBeGreaterThan(0);
		}
	);
});
