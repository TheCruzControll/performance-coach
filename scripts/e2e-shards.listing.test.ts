/**
 * Every sharded CI leg, listed by Playwright with exactly the arguments each shard gets from
 * scripts/e2e-shards.ts: the shards split the leg's tests between them (each test in exactly one
 * shard, none left out) and each runs the full setup. A file of its own, so Vitest lists these legs
 * beside scripts/e2e-projects.test.ts's.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planShards, legWorkers } from './e2e-shards.ts';
import { ciShardedLegs, fileKey, inPool, isSetupRun, listRuns } from './lib/playwright-list.ts';

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

/** Per leg: its own listing and each shard's, in shard order. */
const listings = new Map<string, { whole: string[]; shards: string[][] }>();

beforeAll(async () => {
	const tasks = legs.flatMap((leg) => [
		() => listRuns(leg),
		...Array.from({ length: leg.of }, (_, i) => {
			const args = shardArgs(leg, `${i + 1}/${leg.of}`);
			return () => listRuns(leg, args);
		})
	]);
	const results = await inPool(tasks, 4);
	let at = 0;
	for (const leg of legs) {
		const whole = results[at++]!;
		listings.set(`${leg.group}/${leg.engine}`, { whole, shards: results.slice(at, at + leg.of) });
		at += leg.of;
	}
}, 300_000);

describe('the sharded legs, listed by Playwright with each shard’s list', () => {
	it('find the sharded legs in ci.yml', () => {
		expect(legs.length).toBeGreaterThan(0);
	});

	it.each(legs)(
		'$group/$engine in $of shards: each test in exactly one, the setup in all',
		({ group, engine }) => {
			const { whole, shards } = listings.get(`${group}/${engine}`)!;
			const setup = (runs: string[]) => runs.filter(isSetupRun).sort();
			const functional = (runs: string[]) => runs.filter((r) => !isSetupRun(r));
			expect(functional(whole).length).toBeGreaterThan(0);
			shards.forEach((shard, i) => {
				expect(functional(shard).length, `shard ${i + 1} runs tests`).toBeGreaterThan(0);
				expect(setup(shard), `shard ${i + 1} runs the setup`).toEqual(setup(whole));
			});
			expect(shards.flatMap(functional).sort()).toEqual(functional(whole).sort());
		}
	);

	// A file whose tests a module declares cannot be listed (scripts/e2e-shards.ts
	// SHARD_ONE_FILES): planned into shard 2..n it would silently move to shard 1.
	it.each(legs)(
		'$group/$engine: each shard runs the files planned for it',
		({ group, engine, of }) => {
			const { shards } = listings.get(`${group}/${engine}`)!;
			const seconds = table.legs[`${group}/${engine}`]!;
			const plan = planShards(
				Object.entries(seconds).map(([key, s]) => ({ key, seconds: s })),
				of,
				legWorkers(group)
			);
			const files = (runs: string[]) => [
				...new Set(runs.filter((r) => !isSetupRun(r)).map(fileKey))
			];
			const listed = new Set(files(shards.flat()));
			shards.forEach((shard, i) => {
				const planned = plan[i]!.keys.filter((key) => listed.has(key)).sort();
				if (i === 0) expect(files(shard)).toEqual(expect.arrayContaining(planned));
				else expect(files(shard).sort(), `shard ${i + 1}`).toEqual(planned);
			});
		}
	);
});
