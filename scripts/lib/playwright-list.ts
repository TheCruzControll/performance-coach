/**
 * `playwright test --list --reporter=json` for one CI leg, as CI loads the config (CI=1, no other
 * E2E_* variable but the leg's), spawned without blocking so several listings run at once. Used by
 * the shard tests (scripts/e2e-shards.test.ts, scripts/e2e-shards.listing.test.ts).
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

interface ListedSuite {
	file?: string;
	title: string;
	specs?: { title: string; tests: { projectName: string }[] }[];
	suites?: ListedSuite[];
}

/** The environment a leg's listing runs in: this process's, minus any selection, plus `env`. */
export function legEnv(env: Record<string, string>): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = { CI: '1' };
	for (const [name, value] of Object.entries(process.env)) {
		if (!/^(E2E_|PLAYWRIGHT_JSON_|CI$)/.test(name)) out[name] = value;
	}
	return { ...out, ...env };
}

/**
 * Every `<project> › <file> › <title path>` the leg lists with `args`, keyed by the spec file
 * (also for a test a module that file imports declares).
 */
export function listRuns(
	leg: { group: string; engine: string },
	args: string[] = []
): Promise<string[]> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			'pnpm',
			['exec', 'playwright', 'test', '--list', '--reporter=json', ...args],
			{ cwd: root, env: legEnv({ E2E_GROUP: leg.group, E2E_ENGINE: leg.engine }) }
		);
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
		child.on('error', reject);
		child.on('close', (status) => {
			if (status !== 0) {
				reject(new Error(`playwright --list ${args.join(' ')} failed: ${stderr}`));
				return;
			}
			const runs: string[] = [];
			const walk = (suite: ListedSuite, file: string, titles: string[]) => {
				for (const spec of suite.specs ?? []) {
					for (const test of spec.tests) {
						runs.push([test.projectName, file, ...titles, spec.title].join(' › '));
					}
				}
				for (const child of suite.suites ?? []) walk(child, file, [...titles, child.title]);
			};
			const report = JSON.parse(stdout) as { suites: ListedSuite[] };
			for (const suite of report.suites) walk(suite, suite.file ?? suite.title, []);
			resolve(runs);
		});
	});
}

/** Runs `tasks` with at most `limit` in flight, results in the tasks' order. */
export async function inPool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
	const results: T[] = new Array(tasks.length);
	let next = 0;
	const worker = async () => {
		while (next < tasks.length) {
			const index = next++;
			results[index] = await tasks[index]!();
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
	return results;
}

/** The `<project> › <file>` of a listed run. */
export const fileKey = (run: string) => run.split(' › ').slice(0, 2).join(' › ');

/** Whether a listed run belongs to a setup project. */
export const isSetupRun = (run: string) => /^setup(-\w+)? › /.test(run);

/** Each sharded leg in ci.yml's e2e matrix and its shard count (`of`). */
export function ciShardedLegs(): { group: string; engine: string; of: number }[] {
	const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
	const legs = new Map<string, { group: string; engine: string; of: number }>();
	for (const [, flow] of workflow.matchAll(/^\s*- \{(.*group:.*)\}\s*$/gm)) {
		const entry = Object.fromEntries(
			flow!.split(',').map((pair) => pair.split(':').map((s) => s.trim()))
		) as Record<string, string>;
		const leg = { group: entry.group!, engine: entry.engine!, of: Number(entry.of) };
		if (leg.of > 1) legs.set(`${leg.group}/${leg.engine}`, leg);
	}
	return [...legs.values()];
}
