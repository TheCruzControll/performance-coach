/**
 * Checks the journey map (e2e/journeys.ts) against Playwright's own test listing and the PRD.
 *
 * - Always an error: a malformed or duplicate entry, a pending id that is not a proving slice,
 *   a gap without a reason or for a project the entry does not require.
 * - A mismatch (a mapped title missing from a project that must run it, or an unknown project)
 *   is only reported, unless `strict`; in strict mode a pending entry is an error too.
 */
import { spawnSync } from 'node:child_process';
import { PROVING_SLICES, type JourneyEntry } from '../e2e/journeys.ts';

/** Every test in the listing, `<file> › <title path>` → the projects that run it. */
export interface Listing {
	projects: ReadonlySet<string>;
	tests: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface MapReport {
	errors: string[];
	mismatches: string[];
}

interface JsonSuite {
	title: string;
	file: string;
	specs?: { title: string; tests: { projectName: string }[] }[];
	suites?: JsonSuite[];
}

const key = (file: string, title: string) => `${file} › ${title}`;

/** Reads `playwright test --list --reporter=json` output into a Listing. */
export function parseListing(report: {
	config: { projects: { name: string }[] };
	suites: JsonSuite[];
}): Listing {
	const tests = new Map<string, Set<string>>();
	const walk = (suite: JsonSuite, path: string[]) => {
		for (const spec of suite.specs ?? []) {
			const at = key(suite.file, [...path, spec.title].join(' › '));
			const projects = tests.get(at) ?? new Set<string>();
			for (const test of spec.tests) projects.add(test.projectName);
			tests.set(at, projects);
		}
		for (const child of suite.suites ?? []) walk(child, [...path, child.title]);
	};
	// A top-level suite is a file; its title is the file name, not part of a test's title.
	for (const file of report.suites) walk(file, []);
	return { projects: new Set(report.config.projects.map((p) => p.name)), tests };
}

/**
 * Lists the real suite without running it: no browser, no global setup. CI=1 and no E2E_*
 * variable, so the config yields the projects CI runs (WebKit included) wherever this runs.
 */
export function listSuite(cwd: string): Listing {
	const env: NodeJS.ProcessEnv = { CI: '1' };
	for (const [name, value] of Object.entries(process.env)) {
		if (!/^(E2E_|PLAYWRIGHT_JSON_|CI$)/.test(name)) env[name] = value;
	}
	const run = spawnSync('pnpm', ['exec', 'playwright', 'test', '--list', '--reporter=json'], {
		cwd,
		env,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	if (run.status !== 0) throw new Error(`playwright --list failed: ${run.stderr}`);
	return parseListing(JSON.parse(run.stdout));
}

/** The items of the PRD's §19 journey list and §18 persistence list, as `§NN: <item>`. */
export function prdItems(prd: string): string[] {
	const text = prd.replace(/\s+/g, ' ');
	/** The ';'-separated list after `lead:` up to the next full stop, inside section `n`. */
	const list = (n: number, lead: string) => {
		const section = text.slice(text.indexOf(`## ${n}. `), text.indexOf(`## ${n + 1}. `));
		const match = new RegExp(`${lead}: ([^.]+)\\.`).exec(section);
		if (!match) throw new Error(`PRD §${n}: no "${lead}:" list`);
		return match[1]!.split(';').map((item) => `§${n}: ${item.trim()}`);
	};
	return [...list(19, 'Playwright journeys'), ...list(18, 'Test')];
}

const isText = (value: unknown): value is string =>
	typeof value === 'string' && value.trim() !== '';
const isTextList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.length > 0 && value.every(isText);

export function checkJourneyMap(
	entries: readonly JourneyEntry[],
	listing: Listing,
	{ strict = false } = {}
): MapReport {
	const errors: string[] = [];
	const mismatches: string[] = [];
	const seen = new Set<string>();
	const proving: readonly string[] = PROVING_SLICES;

	for (const raw of entries as readonly unknown[]) {
		const entry = (raw ?? {}) as Record<string, unknown>;
		const id = isText(entry.id) ? entry.id : JSON.stringify(raw);
		const fail = (why: string) => errors.push(`${id}: ${why}`);
		if (!isText(entry.id) || !isText(entry.prd)) {
			fail('needs an id and its PRD wording');
			continue;
		}
		if (seen.has(id)) fail('appears twice');
		seen.add(id);

		if ('pending' in entry) {
			if (!isText(entry.pending) || !proving.includes(entry.pending)) {
				fail(`pending names "${String(entry.pending)}", which is not a proving slice`);
			} else if ('tests' in entry || 'projects' in entry || 'gaps' in entry) {
				fail('is pending, so it lists no tests, projects or gaps');
			} else if (strict) {
				fail(`is still pending ${entry.pending}`);
			}
			continue;
		}

		const tests = entry.tests as unknown[];
		if (!isTextList(entry.projects) || !Array.isArray(tests) || tests.length === 0) {
			fail('needs projects and at least one test, or a pending slice');
			continue;
		}
		const gaps = (entry.gaps ?? []) as unknown[];
		if (!Array.isArray(gaps)) {
			fail('gaps must be a list');
			continue;
		}
		const shaped = tests.every((t) => {
			const test = (t ?? {}) as Record<string, unknown>;
			return (
				isText(test.file) &&
				isText(test.title) &&
				(test.projects === undefined || isTextList(test.projects))
			);
		});
		if (!shaped) {
			fail('every test needs a file, a title and, if given, its projects');
			continue;
		}
		const required = (test: { projects?: string[] }) =>
			test.projects ?? (entry.projects as string[]);
		const all = new Set((tests as { projects?: string[] }[]).flatMap(required));
		const excused = new Set<string>();
		for (const g of gaps) {
			const gap = (g ?? {}) as Record<string, unknown>;
			if (!isText(gap.reason)) fail(`the gap for ${String(gap.project)} has no reason`);
			else if (!isText(gap.project) || !all.has(gap.project)) {
				fail(`a gap names ${String(gap.project)}, which no test of it requires`);
			} else excused.add(gap.project);
		}

		for (const test of tests as { file: string; title: string; projects?: string[] }[]) {
			const projects = listing.tests.get(key(test.file, test.title));
			for (const project of required(test)) {
				if (excused.has(project)) continue;
				if (!listing.projects.has(project)) {
					mismatches.push(`${id}: no project ${project} in the Playwright config`);
				} else if (!projects?.has(project)) {
					mismatches.push(`${id}: ${project} does not run "${key(test.file, test.title)}"`);
				}
			}
		}
	}

	return { errors: strict ? [...errors, ...mismatches] : errors, mismatches };
}
