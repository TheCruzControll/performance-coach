/**
 * scripts/e2e-timing.ts on a fixture report: the minutes per project and per spec file, the
 * warning above the 15-minute ceiling naming the shard count that brings the leg back under, and
 * planned vs measured seconds against the timing table with its warnings (over plan, untimed,
 * flaky, stale).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	CEILING_MINUTES,
	parseShard,
	plan,
	render,
	suggestedShards,
	summarise,
	type JsonReport,
	type TimingTable
} from './e2e-timing.ts';

const MINUTE = 60_000;
const test = (projectName: string, ...minutes: number[]) => ({
	projectName,
	results: minutes.map((m) => ({ duration: m * MINUTE }))
});

/** A shard's report: a nested describe, a retried test and two projects sharing a file. */
function report(
	wallMinutes: number,
	shard: JsonReport['config']['shard'] = null,
	flaky = 0
): JsonReport {
	return {
		config: { shard },
		stats: { duration: wallMinutes * MINUTE, flaky },
		suites: [
			{
				specs: [{ title: 'owner', file: 'auth.setup.ts', tests: [test('setup', 0.5)] }],
				suites: []
			},
			{
				specs: [
					{
						title: 'today',
						file: 'a11y.e2e.ts',
						tests: [test('iphone-chromium', 2), test('desktop-chromium', 3)]
					}
				],
				suites: [
					{
						specs: [
							// failed once, passed on the retry: both attempts took time
							{ title: 'week', file: 'a11y.e2e.ts', tests: [test('iphone-chromium', 1, 1.5)] },
							{ title: 'rail', file: 'shell.e2e.ts', tests: [test('iphone-chromium', 0.25)] }
						]
					}
				]
			}
		]
	};
}

describe('summarise', () => {
	it('sums the minutes per project and per project and spec file, retries included', () => {
		const timing = summarise(report(9));
		expect(timing.minutes).toBe(9);
		expect(timing.shard).toEqual({ current: 1, total: 1 });
		expect(timing.projects).toEqual([
			{ name: 'setup', tests: 1, minutes: 0.5 },
			{ name: 'iphone-chromium', tests: 3, minutes: 4.75 },
			{ name: 'desktop-chromium', tests: 1, minutes: 3 }
		]);
		expect(timing.specs).toEqual([
			{ name: 'iphone-chromium › a11y.e2e.ts', tests: 2, minutes: 4.5 },
			{ name: 'desktop-chromium › a11y.e2e.ts', tests: 1, minutes: 3 },
			{ name: 'setup › auth.setup.ts', tests: 1, minutes: 0.5 },
			{ name: 'iphone-chromium › shell.e2e.ts', tests: 1, minutes: 0.25 }
		]);
	});

	it('counts a test a shared module declares for the spec file that runs it', () => {
		const half = (file: string, minutes: number) => ({
			file,
			specs: [],
			suites: [
				{
					specs: [
						{ title: 'today', file: 'a11y-suite.ts', tests: [test('iphone-chromium', minutes)] }
					]
				}
			]
		});
		const timing = summarise({
			config: { shard: null },
			stats: { duration: 5 * MINUTE, flaky: 0 },
			suites: [half('a11y-dark.e2e.ts', 2), half('a11y-light.e2e.ts', 1)]
		});
		expect(timing.specs).toEqual([
			{ name: 'iphone-chromium › a11y-dark.e2e.ts', tests: 1, minutes: 2 },
			{ name: 'iphone-chromium › a11y-light.e2e.ts', tests: 1, minutes: 1 }
		]);
	});
});

describe('the ceiling', () => {
	it('stays quiet at or under 15 minutes', () => {
		expect(CEILING_MINUTES).toBe(15);
		const timing = summarise(report(15));
		expect(suggestedShards(timing)).toBeUndefined();
		const { markdown, warnings } = render(timing, 'main · chromium');
		expect(warnings).toEqual([]);
		expect(markdown).toContain('### main · chromium, shard 1/1: 15.0 of 15 minutes');
		expect(markdown).toContain('| iphone-chromium | 3 | 4.8 |');
		expect(markdown).toContain('| iphone-chromium › a11y.e2e.ts | 2 | 4.5 |');
	});

	it('warns above it, naming the shard count that brings the leg back under', () => {
		expect(suggestedShards(summarise(report(15.1)))).toBe(2);
		expect(suggestedShards(summarise(report(31)))).toBe(3);
		// a shard of two at 16 minutes: the leg is about 32 minutes, so three shards
		const sharded = summarise(report(16, { current: 2, total: 2 }));
		expect(suggestedShards(sharded)).toBe(3);
		expect(render(sharded, 'serial · webkit').warnings).toEqual([
			'::warning title=E2E leg over 15 minutes::serial · webkit shard 2/2 took 16.0 minutes; ' +
				'raise this leg to 3 shards in ci.yml'
		]);
	});
});

describe('every file, the shard and the retries', () => {
	it('returns every spec file, while the summary lists the slowest 10', () => {
		const files = Array.from({ length: 12 }, (_, i) => ({
			title: 'renders',
			file: `screen-${String(i + 1).padStart(2, '0')}.e2e.ts`,
			tests: [test('iphone-chromium', i + 1)]
		}));
		const timing = summarise({
			config: { shard: null },
			stats: { duration: 9 * MINUTE, flaky: 0 },
			suites: [{ specs: files }]
		});
		expect(timing.specs).toHaveLength(12);
		expect(timing.specs.at(-1)).toEqual({
			name: 'iphone-chromium › screen-01.e2e.ts',
			tests: 1,
			minutes: 1
		});
		const { markdown } = render(timing);
		expect(markdown).toContain('| iphone-chromium › screen-03.e2e.ts | 1 | 3.0 |');
		expect(markdown).not.toContain('screen-02.e2e.ts');
	});

	it('takes the shard from E2E_SHARD only when the report has none', () => {
		expect(parseShard('3/4')).toEqual({ current: 3, total: 4 });
		for (const bad of [undefined, '', '5/4', '0/2', 'two/4', '1/2/3']) {
			expect(parseShard(bad), String(bad)).toBeUndefined();
		}
		expect(summarise(report(9), { current: 3, total: 4 }).shard).toEqual({ current: 3, total: 4 });
		const own = report(9, { current: 1, total: 2 });
		expect(summarise(own, { current: 3, total: 4 }).shard).toEqual({ current: 1, total: 2 });
	});

	it('reports Playwright’s flaky count and every test that ran more than once', () => {
		const timing = summarise(report(9, null, 1));
		expect(timing.flaky).toBe(1);
		expect(timing.retried).toEqual(['iphone-chromium › a11y.e2e.ts › week (2 runs)']);
		const { markdown, warnings } = render(timing, 'main · chromium');
		expect(markdown).toContain("Flaky (Playwright's stats.flaky): 1.");
		expect(markdown).toContain('- iphone-chromium › a11y.e2e.ts › week (2 runs)');
		expect(warnings).toEqual([
			'::warning title=E2E flaky tests::main · chromium shard 1/1: 1 flaky; retried: ' +
				'iphone-chromium › a11y.e2e.ts › week (2 runs)'
		]);
		// a retry that failed again is no flake: the run failed on its own
		expect(render(summarise(report(9)), 'main · chromium').warnings).toEqual([]);
	});
});

describe('planned vs measured', () => {
	const NOW = new Date('2026-11-20T12:00:00Z');
	const table = (planned: Record<string, number>, updated = '2026-11-10'): TimingTable => ({
		updated,
		runs: [1, 2, 3],
		legs: { 'main/chromium': planned, 'main/webkit': { 'iphone-webkit › a11y.e2e.ts': 1 } }
	});
	const on = (planned: Record<string, number>, updated?: string) =>
		render(summarise(report(9)), 'main · chromium', {
			table: table(planned, updated),
			legKey: 'main/chromium',
			now: NOW
		});
	const ALL = {
		'iphone-chromium › a11y.e2e.ts': 270,
		'desktop-chromium › a11y.e2e.ts': 180,
		'iphone-chromium › shell.e2e.ts': 15
	};

	it('lists each file’s planned and measured seconds, leaving out the setup projects', () => {
		expect(plan(summarise(report(9)), { 'iphone-chromium › a11y.e2e.ts': 200 })).toEqual([
			{ name: 'iphone-chromium › a11y.e2e.ts', planned: 200, measured: 270 },
			{ name: 'desktop-chromium › a11y.e2e.ts', planned: undefined, measured: 180 },
			{ name: 'iphone-chromium › shell.e2e.ts', planned: undefined, measured: 15 }
		]);
		const { markdown, warnings } = on(ALL);
		expect(markdown).toContain(
			'| Planned vs measured (e2e/timings.json, main/chromium) | Planned s | Measured s |'
		);
		expect(markdown).toContain('| iphone-chromium › a11y.e2e.ts | 270 | 270 |');
		expect(markdown).toContain('| iphone-chromium › shell.e2e.ts | 15 | 15 |');
		expect(markdown).not.toContain('auth.setup.ts | untimed');
		expect(markdown).toContain('Untimed files: none.');
		expect(markdown).toContain('Timing table updated 2026-11-10 (10 days ago).');
		expect(warnings).toEqual([]);
	});

	it('warns about a file over 1.3× its plan by 10 s or more', () => {
		const { warnings } = on({
			...ALL,
			'iphone-chromium › a11y.e2e.ts': 200, // 270 s: 1.35×, 70 s over
			'desktop-chromium › a11y.e2e.ts': 140, // 180 s: 1.29×, under 1.3×
			'iphone-chromium › shell.e2e.ts': 6 // 15 s: 2.5×, but only 9 s over
		});
		expect(warnings).toEqual([
			'::warning title=E2E files over plan::main · chromium shard 1/1: ' +
				'iphone-chromium › a11y.e2e.ts 270 s of 200 (over 1.3× planned); ' +
				'refresh e2e/timings.json with pnpm e2e:timings'
		]);
		const exactlyTen = on({ ...ALL, 'iphone-chromium › shell.e2e.ts': 5 });
		expect(exactlyTen.warnings).toHaveLength(1);
		expect(exactlyTen.warnings[0]).toContain('iphone-chromium › shell.e2e.ts 15 s of 5');
	});

	it('warns about files the table lacks', () => {
		const { markdown, warnings } = on({ 'iphone-chromium › a11y.e2e.ts': 270 });
		expect(markdown).toContain('| desktop-chromium › a11y.e2e.ts | untimed | 180 |');
		expect(markdown).toContain(
			'Untimed files: desktop-chromium › a11y.e2e.ts, iphone-chromium › shell.e2e.ts.'
		);
		expect(warnings).toEqual([
			'::warning title=E2E files untimed::main · chromium shard 1/1: ' +
				'desktop-chromium › a11y.e2e.ts, iphone-chromium › shell.e2e.ts not in the timing ' +
				'table; refresh e2e/timings.json with pnpm e2e:timings'
		]);
	});

	it('warns once the table is more than 14 days old', () => {
		expect(on(ALL, '2026-11-06').warnings).toEqual([]);
		expect(on(ALL, '2026-11-05').warnings).toEqual([
			'::warning title=E2E timing table stale::updated 2026-11-05, 15 days ago (over 14); ' +
				'refresh e2e/timings.json with pnpm e2e:timings'
		]);
	});

	it('leaves the comparison out without a table or a leg', () => {
		const timing = summarise(report(9));
		expect(render(timing).markdown).not.toContain('Planned vs measured');
		expect(render(timing, 'E2E', { table: table(ALL) }).markdown).not.toContain('Planned');
	});
});

describe('node scripts/e2e-timing.ts', () => {
	const script = fileURLToPath(new URL('./e2e-timing.ts', import.meta.url));

	it('appends the summary to $GITHUB_STEP_SUMMARY and prints the warning', () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'e2e-timing-'));
		const file = path.join(dir, 'report.json');
		const summary = path.join(dir, 'summary.md');
		writeFileSync(file, JSON.stringify(report(20)));
		writeFileSync(summary, '');
		const out = execFileSync(process.execPath, [script, file, 'main · webkit'], {
			env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
			encoding: 'utf8'
		});
		expect(readFileSync(summary, 'utf8')).toContain('### main · webkit, shard 1/1: 20.0 of 15');
		expect(out).toContain('::warning title=E2E leg over 15 minutes::');
	});

	it('compares the leg named by E2E_GROUP and E2E_ENGINE with the table it is given', () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'e2e-timing-'));
		const file = path.join(dir, 'report.json');
		const timings = path.join(dir, 'timings.json');
		writeFileSync(file, JSON.stringify(report(9, null, 1)));
		const table: TimingTable = {
			updated: '2000-01-01',
			runs: [1],
			legs: { 'serial/webkit': { 'iphone-chromium › a11y.e2e.ts': 100 } }
		};
		writeFileSync(timings, JSON.stringify(table));
		const out = execFileSync(process.execPath, [script, file, 'serial · webkit', timings], {
			env: {
				...process.env,
				GITHUB_STEP_SUMMARY: '',
				E2E_GROUP: 'serial',
				E2E_ENGINE: 'webkit',
				E2E_SHARD: '2/4'
			},
			encoding: 'utf8'
		});
		expect(out).toContain('### serial · webkit, shard 2/4: 9.0 of 15 minutes');
		expect(out).toContain('| iphone-chromium › a11y.e2e.ts | 100 | 270 |');
		expect(out).toContain('::warning title=E2E files over plan::serial · webkit shard 2/4');
		expect(out).toContain('::warning title=E2E files untimed::');
		expect(out).toContain('::warning title=E2E timing table stale::updated 2000-01-01');
		expect(out).toContain('::warning title=E2E flaky tests::');
	});

	it('exits cleanly when Playwright wrote no report', () => {
		const out = execFileSync(process.execPath, [script, '/nonexistent/report.json'], {
			env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
			encoding: 'utf8'
		});
		expect(out).toContain('no /nonexistent/report.json');
	});
});
