/**
 * `node scripts/e2e-timing.ts [report.json] [leg]`: where one CI leg's browser minutes went.
 *
 * Reads Playwright's JSON report (playwright.config.ts writes test-results/report.json in CI) and
 * appends the leg's wall-clock minutes, the minutes per project and the slowest spec files to
 * $GITHUB_STEP_SUMMARY (stdout without it). Above the 15-minute ceiling it prints a GitHub warning
 * naming the shard count that would bring the leg back under: a leg gains a shard rather than
 * losing coverage (.github/workflows/ci.yml). It never fails the job; the job's timeout does.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Playwright minutes one leg or shard may take before it gains a shard. */
export const CEILING_MINUTES = 15;
/** How many spec files the summary lists, slowest first. */
const SLOWEST_SPECS = 10;

interface JsonResult {
	duration: number;
}
interface JsonSpec {
	file: string;
	tests: { projectName: string; results: JsonResult[] }[];
}
interface JsonSuite {
	/** A top-level suite's spec file. */
	file?: string;
	specs?: JsonSpec[];
	suites?: JsonSuite[];
}
/** The fields of Playwright's JSON report this script reads. */
export interface JsonReport {
	config: { shard: { current: number; total: number } | null };
	stats: { duration: number };
	suites: JsonSuite[];
}

export interface Minutes {
	name: string;
	tests: number;
	minutes: number;
}

export interface Timing {
	/** Wall-clock minutes of the whole run, global setup included. */
	minutes: number;
	shard: { current: number; total: number };
	projects: Minutes[];
	/** `<project> › <file>`, slowest first. */
	specs: Minutes[];
}

const toMinutes = (ms: number) => ms / 60_000;

/** Sums every result's duration (retries included) per project and per project and file. */
export function summarise(report: JsonReport): Timing {
	const projects = new Map<string, Minutes>();
	const specs = new Map<string, Minutes>();
	const add = (into: Map<string, Minutes>, name: string, ms: number) => {
		const entry = into.get(name) ?? { name, tests: 0, minutes: 0 };
		entry.tests += 1;
		entry.minutes += toMinutes(ms);
		into.set(name, entry);
	};
	// Per spec file: a test a module declares (e2e/a11y-suite.ts) counts for the file running it.
	const walk = (suite: JsonSuite, file: string | undefined) => {
		for (const spec of suite.specs ?? []) {
			for (const test of spec.tests) {
				const ms = test.results.reduce((sum, result) => sum + result.duration, 0);
				add(projects, test.projectName, ms);
				add(specs, `${test.projectName} › ${file ?? spec.file}`, ms);
			}
		}
		for (const child of suite.suites ?? []) walk(child, file);
	};
	for (const suite of report.suites) walk(suite, suite.file);
	return {
		minutes: toMinutes(report.stats.duration),
		shard: report.config.shard ?? { current: 1, total: 1 },
		projects: [...projects.values()],
		specs: [...specs.values()].sort((a, b) => b.minutes - a.minutes).slice(0, SLOWEST_SPECS)
	};
}

/**
 * The shard count that brings this leg's shards under the ceiling, assuming the leg's whole run
 * is about this shard's minutes times its shard count; `undefined` while under the ceiling.
 */
export function suggestedShards(timing: Timing): number | undefined {
	if (timing.minutes <= CEILING_MINUTES) return undefined;
	return Math.ceil((timing.minutes * timing.shard.total) / CEILING_MINUTES);
}

const fixed = (minutes: number) => minutes.toFixed(1);

/** The step summary in Markdown, and the warning annotation above the ceiling. */
export function render(timing: Timing, leg = 'E2E'): { markdown: string; warning?: string } {
	const { current, total } = timing.shard;
	const rows = (list: Minutes[]) =>
		list.map((m) => `| ${m.name} | ${m.tests} | ${fixed(m.minutes)} |`).join('\n');
	const markdown = [
		`### ${leg}, shard ${current}/${total}: ${fixed(timing.minutes)} of ${CEILING_MINUTES} minutes`,
		'',
		'| Project | Tests | Minutes |',
		'| --- | ---: | ---: |',
		rows(timing.projects),
		'',
		'| Slowest spec files | Tests | Minutes |',
		'| --- | ---: | ---: |',
		rows(timing.specs),
		''
	].join('\n');
	const shards = suggestedShards(timing);
	if (shards === undefined) return { markdown };
	return {
		markdown,
		warning:
			`::warning title=E2E leg over ${CEILING_MINUTES} minutes::${leg} shard ${current}/${total} ` +
			`took ${fixed(timing.minutes)} minutes; raise this leg to ${shards} shards in ci.yml`
	};
}

function main(): void {
	const [file = 'test-results/report.json', leg] = process.argv.slice(2);
	if (!existsSync(file)) {
		console.log(`e2e-timing: no ${file}; Playwright wrote no report`);
		return;
	}
	const report = JSON.parse(readFileSync(file, 'utf8')) as JsonReport;
	const { markdown, warning } = render(summarise(report), leg);
	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (summary) appendFileSync(summary, `${markdown}\n`);
	else console.log(markdown);
	if (warning) console.log(warning);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
