/**
 * scripts/e2e-timing.ts on a fixture report: the minutes per project and per spec file, and the
 * warning above the 15-minute ceiling naming the shard count that brings the leg back under.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	CEILING_MINUTES,
	render,
	suggestedShards,
	summarise,
	type JsonReport
} from './e2e-timing.ts';

const MINUTE = 60_000;
const test = (projectName: string, ...minutes: number[]) => ({
	projectName,
	results: minutes.map((m) => ({ duration: m * MINUTE }))
});

/** A shard's report: a nested describe, a retried test and two projects sharing a file. */
function report(wallMinutes: number, shard: JsonReport['config']['shard'] = null): JsonReport {
	return {
		config: { shard },
		stats: { duration: wallMinutes * MINUTE },
		suites: [
			{
				specs: [{ file: 'auth.setup.ts', tests: [test('setup', 0.5)] }],
				suites: []
			},
			{
				specs: [
					{ file: 'a11y.e2e.ts', tests: [test('iphone-chromium', 2), test('desktop-chromium', 3)] }
				],
				suites: [
					{
						specs: [
							// failed once, passed on the retry: both attempts took time
							{ file: 'a11y.e2e.ts', tests: [test('iphone-chromium', 1, 1.5)] },
							{ file: 'shell.e2e.ts', tests: [test('iphone-chromium', 0.25)] }
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
			suites: [{ specs: [{ file: 'a11y-suite.ts', tests: [test('iphone-chromium', minutes)] }] }]
		});
		const timing = summarise({
			config: { shard: null },
			stats: { duration: 5 * MINUTE },
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
		const { markdown, warning } = render(timing, 'main · chromium');
		expect(warning).toBeUndefined();
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
		expect(render(sharded, 'serial · webkit').warning).toBe(
			'::warning title=E2E leg over 15 minutes::serial · webkit shard 2/2 took 16.0 minutes; ' +
				'raise this leg to 3 shards in ci.yml'
		);
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

	it('exits cleanly when Playwright wrote no report', () => {
		const out = execFileSync(process.execPath, [script, '/nonexistent/report.json'], {
			env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
			encoding: 'utf8'
		});
		expect(out).toContain('no /nonexistent/report.json');
	});
});
