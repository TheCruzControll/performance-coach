/**
 * e2e/projects.ts selectProjects: the projects one CI leg runs (.github/workflows/ci.yml). Each
 * leg keeps one engine and one group plus the setup projects it needs, its dependencies point
 * only at kept projects, and together the legs run exactly today's tests. Playwright's --shard
 * splits only projects nothing depends on, so each leg's own functional projects must be those.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Project } from '@playwright/test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	ENGINES,
	GROUPS,
	LEGS,
	parseChoice,
	selectProjects,
	type Engine,
	type Group
} from '../e2e/projects.ts';
import { parseListing, type Listing } from './journey-map.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const SELECTION = ['E2E_WEBKIT', 'E2E_SERIAL_ALONE', 'E2E_PERF_ALONE', 'E2E_ENGINE', 'E2E_GROUP'];

/** playwright.config.ts's projects as CI loads them, with `env` on top. */
async function configProjects(env: Record<string, string> = {}): Promise<Project[]> {
	vi.resetModules(); // the config reads the environment when it loads
	vi.stubEnv('CI', '1');
	for (const name of SELECTION) vi.stubEnv(name, '');
	for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
	const { default: config } = await import('../playwright.config.ts');
	return config.projects ?? [];
}

/** A desktop-shaped project list: the config's shape, without its options. */
function fixture(): Project[] {
	const project = (name: string, browserName: string, dependencies?: string[]): Project => ({
		name,
		use: { browserName: browserName as Engine },
		...(dependencies ? { dependencies } : {})
	});
	const functional = ['iphone-chromium', 'desktop-chromium', 'iphone-webkit'];
	const beforeSweeps = [...functional, 'perf', 'serial-chromium', 'serial-webkit'];
	return [
		project('setup', 'chromium'),
		project('iphone-chromium', 'chromium', ['setup']),
		project('desktop-chromium', 'chromium', ['setup']),
		project('perf', 'chromium', ['serial-webkit']),
		project('setup-webkit', 'webkit', ['setup']),
		project('iphone-webkit', 'webkit', ['setup-webkit']),
		project('serial-chromium', 'chromium', functional),
		project('serial-webkit', 'webkit', ['serial-chromium']),
		project('sweep-chromium', 'chromium', beforeSweeps),
		project('sweep-webkit', 'webkit', ['setup-webkit', 'sweep-chromium']),
		project('exclusive', 'chromium', [...beforeSweeps, 'sweep-chromium', 'sweep-webkit'])
	];
}

const names = (projects: Project[]) => projects.map((p) => p.name);
const dependenciesOf = (projects: Project[], name: string) =>
	projects.find((p) => p.name === name)?.dependencies ?? [];

/** Every project `name` waits for, directly or through its dependencies. */
function after(projects: Project[], name: string): string[] {
	const seen = new Set<string>();
	const visit = (n: string) => {
		for (const dependency of dependenciesOf(projects, n)) {
			if (!seen.has(dependency)) {
				seen.add(dependency);
				visit(dependency);
			}
		}
	};
	visit(name);
	return [...seen].sort();
}

const EXPECTED: Record<string, string[]> = {
	'main/chromium': ['setup', 'iphone-chromium', 'desktop-chromium'],
	'main/webkit': ['setup', 'setup-webkit', 'iphone-webkit'],
	'serial/chromium': ['setup', 'serial-chromium'],
	'serial/webkit': ['setup', 'setup-webkit', 'serial-webkit'],
	'alone/chromium': ['setup', 'perf', 'exclusive']
};

describe.each([
	['the config', () => configProjects()],
	['a desktop-shaped fixture', async () => fixture()]
])('selectProjects on %s', (_, load) => {
	let projects: Project[];
	beforeAll(async () => {
		projects = await load();
	});
	afterEach(() => vi.unstubAllEnvs());

	it('returns the list unchanged when no engine or group is set', () => {
		const selected = selectProjects(projects, {});
		expect(selected).toEqual(projects);
		selected.forEach((project, i) => expect(project, project.name).toBe(projects[i]));
	});

	it.each(LEGS)('keeps $group/$engine its own projects and setup', ({ group, engine }) => {
		expect(names(selectProjects(projects, { engine, group }))).toEqual(
			EXPECTED[`${group}/${engine}`]
		);
	});

	it('keeps the order: setup first, serial after it, exclusive after perf', () => {
		const chromium = selectProjects(projects, { engine: 'chromium', group: 'serial' });
		expect(after(chromium, 'serial-chromium')).toEqual(['setup']);
		const alone = selectProjects(projects, { engine: 'chromium', group: 'alone' });
		expect(after(alone, 'perf')).toEqual(['setup']);
		expect(after(alone, 'exclusive')).toEqual(['perf', 'setup']);

		const webkit = selectProjects(projects, { engine: 'webkit', group: 'serial' });
		expect(after(webkit, 'serial-webkit')).toEqual(['setup', 'setup-webkit']);
		for (const engine of ENGINES) {
			const main = selectProjects(projects, { engine, group: 'main' });
			for (const name of names(main).filter((n) => !n!.startsWith('setup'))) {
				expect(after(main, name!), name).toContain(engine === 'webkit' ? 'setup-webkit' : 'setup');
			}
			const sweeps = selectProjects(projects, { engine, group: 'sweeps' });
			expect(after(sweeps, `sweep-${engine}`)).toEqual(
				engine === 'webkit' ? ['setup', 'setup-webkit'] : ['setup']
			);
		}
	});

	it.each(LEGS)('$group/$engine depends only on projects it keeps', ({ group, engine }) => {
		const selected = selectProjects(projects, { engine, group });
		const kept = new Set(names(selected));
		for (const project of selected) {
			for (const dependency of project.dependencies ?? []) {
				expect(kept, `${project.name} → ${dependency}`).toContain(dependency);
			}
		}
	});

	it('leaves nothing depending on a main or serial leg\u2019s projects, so --shard splits them', () => {
		for (const leg of LEGS.filter((l) => l.group !== 'alone')) {
			const selected = selectProjects(projects, leg);
			const depended = new Set(selected.flatMap((p) => p.dependencies ?? []));
			expect(
				[...depended].filter((n) => !n.startsWith('setup')),
				`${leg.group}/${leg.engine}`
			).toEqual([]);
		}
	});

	it('selects one engine across groups when only the engine is set', () => {
		expect(names(selectProjects(projects, { engine: 'webkit' }))).toEqual([
			'setup',
			'setup-webkit',
			'iphone-webkit',
			'serial-webkit',
			'sweep-webkit'
		]);
	});
});

describe('selectProjects input', () => {
	it('throws on a project with an unknown browserName', () => {
		const projects = [...fixture(), { name: 'firefox', use: { browserName: 'firefox' } }];
		expect(() => selectProjects(projects as Project[], {})).toThrow(/firefox/);
		expect(() => selectProjects(projects as Project[], { engine: 'chromium' })).toThrow(/firefox/);
		expect(() => selectProjects([{ name: 'bare' }], { group: 'main' })).toThrow(/bare/);
	});

	it('refuses an unknown E2E_ENGINE or E2E_GROUP', () => {
		expect(parseChoice('E2E_ENGINE', 'webkit', ENGINES)).toBe('webkit');
		expect(parseChoice('E2E_GROUP', '', GROUPS)).toBeUndefined();
		expect(() => parseChoice('E2E_ENGINE', 'firefox', ENGINES)).toThrow(/E2E_ENGINE=firefox/);
		expect(() => parseChoice('E2E_GROUP', 'all', GROUPS)).toThrow(/E2E_GROUP=all/);
	});
});

describe('playwright.config.ts legs', () => {
	afterEach(() => vi.unstubAllEnvs());

	it('applies E2E_ENGINE and E2E_GROUP', async () => {
		const projects = await configProjects({ E2E_ENGINE: 'webkit', E2E_GROUP: 'serial' });
		expect(names(projects)).toEqual(EXPECTED['serial/webkit']);
	});

	it('adds WebKit outside CI when E2E_ENGINE=webkit', async () => {
		const projects = await configProjects({ E2E_ENGINE: 'webkit', E2E_GROUP: 'main' });
		vi.resetModules();
		vi.stubEnv('CI', '');
		const { default: config } = await import('../playwright.config.ts');
		expect(names(config.projects ?? [])).toEqual(names(projects));
	});

	// main legs run whole files side by side on 2 workers, as every local run does; every other
	// leg (and the whole suite in one CI job) keeps 1.
	it.each([
		['main', 2],
		['serial', 1],
		['alone', 1],
		['sweeps', 1],
		['', 1]
	] as const)('gives E2E_GROUP=%j %i worker(s) in CI', async (group, workers) => {
		await configProjects({ E2E_GROUP: group });
		const { default: config } = await import('../playwright.config.ts');
		expect(config.workers).toBe(workers);
	});

	it('keeps 2 workers outside CI', async () => {
		await configProjects({ E2E_GROUP: 'serial' });
		vi.resetModules();
		vi.stubEnv('CI', '');
		const { default: config } = await import('../playwright.config.ts');
		expect(config.workers).toBe(2);
	});
});

/** `playwright test --list` for one leg (or today's whole suite), as CI loads the config. */
function list(leg: { engine?: Engine; group?: Group; shard?: string } = {}): Listing {
	const env: NodeJS.ProcessEnv = { CI: '1' };
	for (const [name, value] of Object.entries(process.env)) {
		if (!/^(E2E_|PLAYWRIGHT_JSON_|CI$)/.test(name)) env[name] = value;
	}
	if (leg.engine) env.E2E_ENGINE = leg.engine;
	if (leg.group) env.E2E_GROUP = leg.group;
	const args = ['exec', 'playwright', 'test', '--list', '--reporter=json'];
	const run = spawnSync('pnpm', leg.shard ? [...args, '--shard', leg.shard] : args, {
		cwd: root,
		env,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	if (run.status !== 0) throw new Error(`playwright --list failed: ${run.stderr}`);
	return parseListing(JSON.parse(run.stdout));
}

/** Every `<project> › <file> › <title>` a listing runs. */
const runs = (listing: Listing) =>
	[...listing.tests].flatMap(([test, projects]) => [...projects].map((p) => `${p} › ${test}`));

/** The runs outside the setup projects. */
const beyondSetup = (tests: string[]) => tests.filter((t) => !t.startsWith('setup'));

/** The group and engine pairs CI runs no leg for. */
const unrun = () => {
	const run = new Set(LEGS.map((l) => `${l.group}/${l.engine}`));
	return GROUPS.flatMap((group) =>
		ENGINES.filter((e) => !run.has(`${group}/${e}`)).map((engine) => ({ group, engine }))
	);
};

/** Each sharded leg in ci.yml's e2e matrix and its shard count (`of`). */
function shardedLegs(): { group: Group; engine: Engine; of: number }[] {
	const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
	const legs = new Map<string, { group: Group; engine: Engine; of: number }>();
	for (const [, flow] of workflow.matchAll(/^\s*- \{(.*group:.*)\}\s*$/gm)) {
		const entry = Object.fromEntries(
			flow!.split(',').map((pair) => pair.split(':').map((s) => s.trim()))
		);
		const of = Number(entry.of);
		const leg = { group: entry.group as Group, engine: entry.engine as Engine, of };
		if (of > 1) legs.set(`${leg.group}/${leg.engine}`, leg);
	}
	return [...legs.values()];
}

describe('the legs, listed by Playwright', () => {
	const listings = new Map<string, Listing>();
	/** list(), once per leg for the whole describe: each listing spawns Playwright. */
	const listed = (leg: { engine?: Engine; group?: Group } = {}) => {
		const key = `${leg.group}/${leg.engine}`;
		if (!listings.has(key)) listings.set(key, list(leg));
		return listings.get(key)!;
	};

	it('run exactly today\u2019s tests between them', () => {
		const today = new Set(runs(listed()));
		const legs = new Set(
			LEGS.flatMap((leg) => {
				const listing = listed(leg);
				const name = `${leg.group}/${leg.engine}`;
				expect([...listing.projects], name).toEqual(EXPECTED[name]);
				return runs(listing);
			})
		);
		expect(today.size).toBeGreaterThan(0);
		expect([...legs].sort()).toEqual([...today].sort());
	}, 120_000);

	it('each run a test beyond the setup, so no leg is spent on setup alone', () => {
		for (const leg of LEGS) {
			expect(beyondSetup(runs(listed(leg))).length, `${leg.group}/${leg.engine}`).toBeGreaterThan(
				0
			);
		}
	}, 120_000);

	// A group may keep projects with no specs yet (sweep-*, until the first *.sweep.e2e.ts): CI
	// runs no leg for them, and they must list no test, or that test would go unrun.
	it('leave no test to a group and engine CI runs no leg for', () => {
		for (const leg of unrun()) {
			expect(beyondSetup(runs(listed(leg))), `${leg.group}/${leg.engine}`).toEqual([]);
		}
	}, 120_000);

	it('find the sharded legs in ci.yml', () => {
		expect(shardedLegs().length).toBeGreaterThan(0);
	});

	it.each(shardedLegs())(
		'shard $group/$engine $of ways: its shards split its tests and each runs the setup',
		({ group, engine, of }) => {
			const leg = { group, engine };
			const whole = runs(list(leg));
			const shards = Array.from({ length: of }, (_, i) =>
				runs(list({ ...leg, shard: `${i + 1}/${of}` }))
			);
			const isSetup = (test: string) => /^setup(-\w+)? › /.test(test);
			const setup = (tests: string[]) => tests.filter(isSetup);
			const functional = (tests: string[]) => tests.filter((t) => !isSetup(t));
			for (const shard of shards) {
				expect(functional(shard).length, 'each shard runs functional tests').toBeGreaterThan(0);
				expect(functional(shard).length).toBeLessThan(functional(whole).length);
				expect(setup(shard).sort()).toEqual(setup(whole).sort());
			}
			expect(shards.flatMap(functional).sort()).toEqual(functional(whole).sort());
		},
		120_000
	);
});
