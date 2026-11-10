/**
 * scripts/e2e-timings.ts on fixture artifact folders: each leg's files summed over its shards,
 * the median over runs, a run missing a shard refused, and the committed table in the shape the
 * command writes, covering every CI leg.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGS } from '../e2e/projects.ts';
import { TIMINGS_FILE, type JsonReport, type TimingTable } from './e2e-timing.ts';
import { buildTable, legOf, median, runSeconds, serialise } from './e2e-timings.ts';

const SECOND = 1000;
/** One shard's report: `<project>`, `<file>` and the seconds of each of the file's results. */
function shardReport(
	shard: { current: number; total: number },
	files: [project: string, file: string, ...seconds: number[]][]
): JsonReport {
	return {
		config: { shard },
		stats: { duration: 60 * SECOND, flaky: 0 },
		suites: files.map(([projectName, file, ...seconds]) => ({
			file,
			specs: [
				{
					title: 'works',
					file,
					tests: [{ projectName, results: seconds.map((s) => ({ duration: s * SECOND })) }]
				}
			]
		}))
	};
}

/** Writes artifacts the way `gh run download` lays them out: one folder per artifact. */
function artifacts(run: number, shards: Record<string, JsonReport>): string {
	const dir = mkdtempSync(path.join(tmpdir(), 'e2e-timings-'));
	for (const [name, report] of Object.entries(shards)) {
		const results = path.join(dir, `playwright-${run}-${name}`, 'test-results');
		mkdirSync(results, { recursive: true });
		writeFileSync(path.join(results, 'report.json'), JSON.stringify(report));
	}
	return dir;
}

/** A run of two legs: main·chromium in two shards, alone·chromium in one. */
function run(id: number, a11y: number, shell: number): string {
	return artifacts(id, {
		'main-chromium-1': shardReport({ current: 1, total: 2 }, [
			['setup', 'auth.setup.ts', 5],
			['iphone-chromium', 'a11y-dark.e2e.ts', a11y],
			['desktop-chromium', 'shell.e2e.ts', shell]
		]),
		'main-chromium-2': shardReport({ current: 2, total: 2 }, [
			['setup', 'auth.setup.ts', 6],
			// the same file in both shards (fullyParallel splits tests): summed over the leg
			['iphone-chromium', 'a11y-dark.e2e.ts', 1, 2]
		]),
		'alone-chromium-1': shardReport({ current: 1, total: 1 }, [['perf', 'perf.e2e.ts', 100]])
	});
}

describe('legOf', () => {
	it('reads the leg and shard from the artifact name of that run only', () => {
		expect(legOf('playwright-42-serial-webkit-3', 42)).toEqual({ leg: 'serial/webkit', shard: 3 });
		expect(legOf('playwright-42-serial-webkit-3', 43)).toBeUndefined();
		expect(legOf('lighthouse-42', 42)).toBeUndefined();
	});
});

describe('runSeconds', () => {
	it('sums each leg’s files over its shards, retries included, without the setup projects', () => {
		const dir = run(7, 10, 4);
		// another workflow artifact in the same folder is not a leg
		mkdirSync(path.join(dir, 'lighthouse-7'));
		expect(runSeconds(dir, 7)).toEqual({
			'main/chromium': {
				'iphone-chromium › a11y-dark.e2e.ts': 13,
				'desktop-chromium › shell.e2e.ts': 4
			},
			'alone/chromium': { 'perf › perf.e2e.ts': 100 }
		});
	});

	it('refuses a run that lacks one of a leg’s shards', () => {
		const dir = artifacts(8, {
			'serial-webkit-1': shardReport({ current: 1, total: 4 }, [['serial-webkit', 'a.e2e.ts', 1]]),
			'serial-webkit-3': shardReport({ current: 3, total: 4 }, [['serial-webkit', 'b.e2e.ts', 1]])
		});
		expect(() => runSeconds(dir, 8)).toThrow('run 8: serial/webkit has shards 1, 3 of 4');
	});

	it('counts a leg’s shards from the artifact names when the reports name none', () => {
		const unnamed = (report: JsonReport): JsonReport => ({ ...report, config: { shard: null } });
		const dir = artifacts(11, {
			'serial-webkit-1': unnamed(
				shardReport({ current: 1, total: 2 }, [['serial-webkit', 'a.e2e.ts', 1]])
			),
			'serial-webkit-2': unnamed(
				shardReport({ current: 2, total: 2 }, [['serial-webkit', 'b.e2e.ts', 2]])
			)
		});
		expect(runSeconds(dir, 11)).toEqual({
			'serial/webkit': { 'serial-webkit › a.e2e.ts': 1, 'serial-webkit › b.e2e.ts': 2 }
		});
	});

	it('refuses a folder with no reports of that run', () => {
		expect(() => runSeconds(run(9, 1, 1), 10)).toThrow('run 10: no playwright-* reports');
	});
});

describe('buildTable', () => {
	it('takes the median of odd and even counts', () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 3, 2])).toBe(2.5);
		expect(median([5])).toBe(5);
	});

	it('keeps each file’s median over the runs that ran it, sorted, dated by the newest run', () => {
		const runs = [
			{ id: 30, day: '2026-11-09', legs: runSeconds(run(30, 20, 4.04), 30) },
			{ id: 10, day: '2026-11-10', legs: runSeconds(run(10, 10, 3), 10) },
			{
				id: 20,
				day: '2026-11-08',
				legs: {
					...runSeconds(run(20, 40, 5), 20),
					'serial/webkit': { 'serial-webkit › new.serial.e2e.ts': 9 }
				}
			}
		];
		const table = buildTable(runs);
		expect(table).toEqual({
			updated: '2026-11-10',
			runs: [10, 20, 30],
			legs: {
				'alone/chromium': { 'perf › perf.e2e.ts': 100 },
				'main/chromium': {
					'desktop-chromium › shell.e2e.ts': 4,
					'iphone-chromium › a11y-dark.e2e.ts': 23
				},
				'serial/webkit': { 'serial-webkit › new.serial.e2e.ts': 9 }
			}
		} satisfies TimingTable);
		// sorted keys, not insertion order
		expect(Object.keys(table.legs)).toEqual(['alone/chromium', 'main/chromium', 'serial/webkit']);
		expect(Object.keys(table.legs['main/chromium']!)).toEqual([
			'desktop-chromium › shell.e2e.ts',
			'iphone-chromium › a11y-dark.e2e.ts'
		]);
	});

	it('serialises tab-indented with the run ids on one line, and reads back the same', () => {
		const table: TimingTable = {
			updated: '2026-11-10',
			runs: [1, 2, 3],
			legs: { 'main/webkit': { 'iphone-webkit › a.e2e.ts': 1.5 } }
		};
		expect(serialise(table)).toBe(
			'{\n\t"updated": "2026-11-10",\n\t"runs": [1, 2, 3],\n\t"legs": {\n' +
				'\t\t"main/webkit": {\n\t\t\t"iphone-webkit › a.e2e.ts": 1.5\n\t\t}\n\t}\n}\n'
		);
		expect(JSON.parse(serialise(table))).toEqual(table);
	});
});

describe('e2e/timings.json', () => {
	const source = readFileSync(TIMINGS_FILE, 'utf8');
	const table = JSON.parse(source) as TimingTable;

	it('is exactly what pnpm e2e:timings writes', () => {
		expect(serialise(buildTableFrom(table))).toBe(source);
	});

	it('times CI legs from at least three runs', () => {
		const legs = LEGS.map((l) => `${l.group}/${l.engine}`);
		for (const leg of Object.keys(table.legs)) expect(legs, leg).toContain(leg);
		expect(table.runs.length).toBeGreaterThanOrEqual(3);
		expect(table.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});

/** The committed table rebuilt as one run, so buildTable's sorting and rounding apply to it. */
function buildTableFrom(table: TimingTable): TimingTable {
	return { ...buildTable([{ id: 0, day: table.updated, legs: table.legs }]), runs: table.runs };
}
