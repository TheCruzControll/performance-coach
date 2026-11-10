/**
 * `pnpm e2e:timings <run-id>…`: rebuilds the e2e timing table (e2e/timings.json) from CI runs.
 *
 * For each run it downloads the playwright-* artifacts with `gh` into a temporary folder; each
 * artifact (playwright-<run>-<group>-<engine>-<shard>, .github/workflows/ci.yml) holds one shard's
 * test-results/report.json. A file's seconds in a run are its results' durations summed over the
 * leg's shards (scripts/e2e-timing.ts summarise), and the table keeps each file's median over the
 * runs that ran it. The owner setup projects run in every shard and are left out. A run missing
 * one of a leg's shards (a cancelled leg) is refused: pass green runs. `updated` is the day of the
 * newest run, so the same runs always give the same table.
 *
 * It needs `gh` signed in and the network, so it runs on demand (docs/testing.md), never in CI.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	isSetup,
	summarise,
	TIMINGS_FILE,
	type JsonReport,
	type TimingTable
} from './e2e-timing.ts';

export const REPOSITORY = 'TheCruzControll/performance-coach';

/** `<group>/<engine>` and the shard of an artifact named playwright-<run>-<group>-<engine>-<n>. */
export function legOf(artifact: string, run: number): { leg: string; shard: number } | undefined {
	const match = new RegExp(`^playwright-${run}-(\\w+)-(\\w+)-(\\d+)$`).exec(artifact);
	return match ? { leg: `${match[1]}/${match[2]}`, shard: Number(match[3]) } : undefined;
}

/** One run's legs: each file's seconds, summed over the leg's shards. */
export type RunSeconds = Record<string, Record<string, number>>;

/** Reads the artifacts of `run` downloaded into `dir` and sums each leg's files over its shards. */
export function runSeconds(dir: string, run: number): RunSeconds {
	const shards = new Map<string, { shard: number; report: JsonReport }[]>();
	for (const artifact of readdirSync(dir).sort()) {
		const where = legOf(artifact, run);
		const file = path.join(dir, artifact, 'test-results', 'report.json');
		if (!where || !existsSync(file)) continue;
		const report = JSON.parse(readFileSync(file, 'utf8')) as JsonReport;
		shards.set(where.leg, [...(shards.get(where.leg) ?? []), { shard: where.shard, report }]);
	}
	if (shards.size === 0) throw new Error(`run ${run}: no playwright-* reports in ${dir}`);
	const legs: RunSeconds = {};
	for (const [leg, reports] of shards) {
		const have = reports.map((r) => r.shard).sort((a, b) => a - b);
		// a report sharded by E2E_SHARD names no shard: the artifact names give the count
		const total = reports[0]!.report.config.shard?.total ?? have.at(-1)!;
		if (have.join() !== Array.from({ length: total }, (_, i) => i + 1).join()) {
			throw new Error(
				`run ${run}: ${leg} has shards ${have.join(', ')} of ${total}; pass green runs`
			);
		}
		const files: Record<string, number> = {};
		for (const { report } of reports) {
			for (const spec of summarise(report).specs) {
				if (isSetup(spec.name)) continue;
				files[spec.name] = (files[spec.name] ?? 0) + spec.minutes * 60;
			}
		}
		legs[leg] = files;
	}
	return legs;
}

export function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const byKey = <T>(entries: [string, T][]) =>
	Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** The table: per leg and file, the median seconds (to 0.1 s) over the runs that ran the file. */
export function buildTable(runs: { id: number; day: string; legs: RunSeconds }[]): TimingTable {
	const samples = new Map<string, Map<string, number[]>>();
	for (const run of runs) {
		for (const [leg, files] of Object.entries(run.legs)) {
			const into = samples.get(leg) ?? new Map<string, number[]>();
			for (const [file, s] of Object.entries(files)) into.set(file, [...(into.get(file) ?? []), s]);
			samples.set(leg, into);
		}
	}
	return {
		updated: runs
			.map((r) => r.day)
			.sort()
			.at(-1)!,
		runs: runs.map((r) => r.id).sort((a, b) => a - b),
		legs: byKey(
			[...samples].map(([leg, files]) => [
				leg,
				byKey([...files].map(([file, s]) => [file, Math.round(median(s) * 10) / 10]))
			])
		)
	};
}

/** The table as committed: tab-indented like the repository's Prettier, run ids on one line. */
export function serialise(table: TimingTable): string {
	return `${JSON.stringify(table, null, '\t').replace(
		/"runs": \[[^\]]*\]/,
		`"runs": [${table.runs.join(', ')}]`
	)}\n`;
}

function gh(args: string[]): string {
	return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function main(): void {
	const ids = process.argv.slice(2).map(Number);
	if (ids.length === 0 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
		console.error('usage: pnpm e2e:timings <run-id>…  (green CI runs of main)');
		process.exitCode = 1;
		return;
	}
	const runs = ids.map((id) => {
		const dir = mkdtempSync(path.join(tmpdir(), `e2e-timings-${id}-`));
		try {
			gh(['run', 'download', String(id), '-R', REPOSITORY, '-p', 'playwright-*', '-D', dir]);
			const created = gh(['api', `repos/${REPOSITORY}/actions/runs/${id}`, '--jq', '.created_at']);
			return { id, day: created.trim().slice(0, 10), legs: runSeconds(dir, id) };
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	const table = buildTable(runs);
	writeFileSync(TIMINGS_FILE, serialise(table));
	const files = Object.values(table.legs).reduce(
		(n, legFiles) => n + Object.keys(legFiles).length,
		0
	);
	console.log(
		`e2e-timings: ${files} files in ${Object.keys(table.legs).length} legs from runs ${table.runs.join(', ')}`
	);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
