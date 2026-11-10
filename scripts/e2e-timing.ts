/**
 * `node scripts/e2e-timing.ts [report.json] [leg] [timings.json]`: where one CI leg's browser
 * minutes went.
 *
 * Reads Playwright's JSON report (playwright.config.ts writes test-results/report.json in CI) and
 * appends the leg's wall-clock minutes, the minutes per project, the slowest spec files, each
 * file's measured seconds against the timing table (e2e/timings.json, `pnpm e2e:timings`), the
 * files the table lacks, Playwright's flaky count and the retried tests to $GITHUB_STEP_SUMMARY
 * (stdout without it). The table's leg is E2E_GROUP/E2E_ENGINE; the shard comes from the report,
 * or E2E_SHARD (`<current>/<total>`) when the report has none.
 *
 * It prints a GitHub warning above the 15-minute ceiling, naming the shard count that would bring
 * the leg back under (a leg gains a shard rather than losing coverage, .github/workflows/ci.yml);
 * when a file takes over 1.3 times its planned seconds (and at least 10 s more); when a file is untimed; when a test was
 * flaky; and when the table is over 14 days old. Each of the last four means: refresh the table.
 * It never fails the job; the job's timeout does.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Playwright minutes one leg or shard may take before it gains a shard. */
export const CEILING_MINUTES = 15;
/** Measured over planned seconds above which a file is called out. */
export const OVER_PLAN = 1.3;
/**
 * Seconds a file must also run over its plan to be called out: tiny files swing past 1.3×
 * (0.1 s to 0.2 s in green main runs) without moving any shard's wall clock.
 */
export const OVER_PLAN_MIN_SECONDS = 10;
/** Days after which the timing table is stale. */
export const STALE_DAYS = 14;
/** How many spec files the summary lists, slowest first. */
const SLOWEST_SPECS = 10;

interface JsonResult {
	duration: number;
}
interface JsonTest {
	projectName: string;
	results: JsonResult[];
}
interface JsonSpec {
	title: string;
	file: string;
	tests: JsonTest[];
}
interface JsonSuite {
	/** A top-level suite's spec file. */
	file?: string;
	specs?: JsonSpec[];
	suites?: JsonSuite[];
}
export interface Shard {
	current: number;
	total: number;
}
/** The fields of Playwright's JSON report this script reads. */
export interface JsonReport {
	config: { shard: Shard | null };
	stats: { duration: number; flaky: number };
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
	shard: Shard;
	projects: Minutes[];
	/** Every `<project> › <file>`, slowest first. */
	specs: Minutes[];
	/** Playwright's count of tests that failed and then passed on a retry. */
	flaky: number;
	/** `<project> › <file> › <title> (<n> runs)` of each test that ran more than once. */
	retried: string[];
}

/** The timing table: per leg (`<group>/<engine>`), each `<project> › <file>`'s seconds. */
export interface TimingTable {
	/** The day (YYYY-MM-DD) of the newest run the table was built from. */
	updated: string;
	runs: number[];
	legs: Record<string, Record<string, number>>;
}

const toMinutes = (ms: number) => ms / 60_000;

/** `<current>/<total>` as a shard; `undefined` when unset or malformed. */
export function parseShard(value: string | undefined): Shard | undefined {
	const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
	if (!match) return undefined;
	const [current, total] = [Number(match[1]), Number(match[2])];
	return current >= 1 && current <= total ? { current, total } : undefined;
}

/**
 * Sums every result's duration (retries included) per project and per project and file.
 * `fallbackShard` stands in when the report names no shard (E2E_SHARD).
 */
export function summarise(report: JsonReport, fallbackShard?: Shard): Timing {
	const projects = new Map<string, Minutes>();
	const specs = new Map<string, Minutes>();
	const retried: string[] = [];
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
				const name = `${test.projectName} › ${file ?? spec.file}`;
				add(projects, test.projectName, ms);
				add(specs, name, ms);
				if (test.results.length > 1) {
					retried.push(`${name} › ${spec.title} (${test.results.length} runs)`);
				}
			}
		}
		for (const child of suite.suites ?? []) walk(child, file);
	};
	for (const suite of report.suites) walk(suite, suite.file);
	return {
		minutes: toMinutes(report.stats.duration),
		shard: report.config.shard ?? fallbackShard ?? { current: 1, total: 1 },
		projects: [...projects.values()],
		specs: [...specs.values()].sort((a, b) => b.minutes - a.minutes),
		flaky: report.stats.flaky ?? 0,
		retried
	};
}

/**
 * The owner setup projects run in full in every shard of a leg, so the table plans no seconds
 * for them (e2e/projects.ts).
 */
export const isSetup = (spec: string) => /^setup(-\w+)? › /.test(spec);

export interface PlannedFile {
	name: string;
	/** Seconds in the table; `undefined` for an untimed file. */
	planned?: number;
	measured: number;
}

/** This shard's files, slowest first, with their planned seconds where the table has them. */
export function plan(timing: Timing, planned: Record<string, number> = {}): PlannedFile[] {
	return timing.specs
		.filter((spec) => !isSetup(spec.name))
		.map((spec) => ({ name: spec.name, planned: planned[spec.name], measured: spec.minutes * 60 }));
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
const seconds = (s: number) => s.toFixed(0);
const DAY_MS = 86_400_000;

/** Whole days from the table's `updated` day to `now`. */
export function ageInDays(updated: string, now: Date): number {
	return Math.floor((now.getTime() - Date.parse(`${updated}T00:00:00Z`)) / DAY_MS);
}

export interface RenderOptions {
	/** The timing table; without one, the planned columns and the table warnings are left out. */
	table?: TimingTable;
	/** The table's leg, `<group>/<engine>`. */
	legKey?: string;
	now?: Date;
}

/** The step summary in Markdown, and the warning annotations. */
export function render(
	timing: Timing,
	leg = 'E2E',
	{ table, legKey, now = new Date() }: RenderOptions = {}
): { markdown: string; warnings: string[] } {
	const { current, total } = timing.shard;
	const where = `${leg} shard ${current}/${total}`;
	const rows = (list: Minutes[]) =>
		list.map((m) => `| ${m.name} | ${m.tests} | ${fixed(m.minutes)} |`).join('\n');
	const lines = [
		`### ${leg}, shard ${current}/${total}: ${fixed(timing.minutes)} of ${CEILING_MINUTES} minutes`,
		'',
		'| Project | Tests | Minutes |',
		'| --- | ---: | ---: |',
		rows(timing.projects),
		'',
		'| Slowest spec files | Tests | Minutes |',
		'| --- | ---: | ---: |',
		rows(timing.specs.slice(0, SLOWEST_SPECS)),
		''
	];
	const warnings: string[] = [];
	const shards = suggestedShards(timing);
	if (shards !== undefined) {
		warnings.push(
			`::warning title=E2E leg over ${CEILING_MINUTES} minutes::${where} ` +
				`took ${fixed(timing.minutes)} minutes; raise this leg to ${shards} shards in ci.yml`
		);
	}

	if (table && legKey) {
		const files = plan(timing, table.legs[legKey]);
		const over = files.filter(
			(f) =>
				f.planned !== undefined &&
				f.measured > OVER_PLAN * f.planned &&
				f.measured - f.planned >= OVER_PLAN_MIN_SECONDS
		);
		const untimed = files.filter((f) => f.planned === undefined);
		const age = ageInDays(table.updated, now);
		lines.push(
			`| Planned vs measured (e2e/timings.json, ${legKey}) | Planned s | Measured s |`,
			'| --- | ---: | ---: |',
			...files.map(
				(f) =>
					`| ${f.name} | ${f.planned === undefined ? 'untimed' : seconds(f.planned)} | ` +
					`${seconds(f.measured)} |`
			),
			'',
			`Untimed files: ${untimed.length === 0 ? 'none' : untimed.map((f) => f.name).join(', ')}.`,
			`Timing table updated ${table.updated} (${age} days ago).`,
			''
		);
		const refresh = 'refresh e2e/timings.json with pnpm e2e:timings';
		if (over.length > 0) {
			const named = over.map((f) => `${f.name} ${seconds(f.measured)} s of ${seconds(f.planned!)}`);
			warnings.push(
				`::warning title=E2E files over plan::${where}: ${named.join(', ')} ` +
					`(over ${OVER_PLAN}× planned); ${refresh}`
			);
		}
		if (untimed.length > 0) {
			warnings.push(
				`::warning title=E2E files untimed::${where}: ${untimed.map((f) => f.name).join(', ')} ` +
					`not in the timing table; ${refresh}`
			);
		}
		if (age > STALE_DAYS) {
			warnings.push(
				`::warning title=E2E timing table stale::updated ${table.updated}, ${age} days ago ` +
					`(over ${STALE_DAYS}); ${refresh}`
			);
		}
	}

	lines.push(
		`Flaky (Playwright's stats.flaky): ${timing.flaky}.`,
		`Retried tests: ${timing.retried.length === 0 ? 'none.' : ''}`,
		...timing.retried.map((name) => `- ${name}`),
		''
	);
	if (timing.flaky > 0) {
		warnings.push(
			`::warning title=E2E flaky tests::${where}: ${timing.flaky} flaky; retried: ` +
				timing.retried.join(', ')
		);
	}
	return { markdown: lines.join('\n'), warnings };
}

/** The committed timing table. */
export const TIMINGS_FILE = fileURLToPath(new URL('../e2e/timings.json', import.meta.url));

function main(): void {
	const [file = 'test-results/report.json', leg, timings = TIMINGS_FILE] = process.argv.slice(2);
	if (!existsSync(file)) {
		console.log(`e2e-timing: no ${file}; Playwright wrote no report`);
		return;
	}
	const report = JSON.parse(readFileSync(file, 'utf8')) as JsonReport;
	const table = existsSync(timings)
		? (JSON.parse(readFileSync(timings, 'utf8')) as TimingTable)
		: undefined;
	const { E2E_GROUP: group, E2E_ENGINE: engine, E2E_SHARD: shard } = process.env;
	const legKey = group && engine ? `${group}/${engine}` : undefined;
	const { markdown, warnings } = render(summarise(report, parseShard(shard)), leg, {
		table,
		legKey
	});
	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (summary) appendFileSync(summary, `${markdown}\n`);
	else console.log(markdown);
	for (const warning of warnings) console.log(warning);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
