/**
 * e2e/projects.ts selectProjects: the projects one CI leg runs (.github/workflows/ci.yml). Each
 * leg keeps one engine and one group plus the setup projects it needs, its dependencies point
 * only at kept projects, and together the legs run exactly today's tests. Playwright's shard
 * list (--test-list, scripts/e2e-shards.ts) filters only projects nothing depends on, so each
 * leg's own functional projects must be those. Each shard's listing is in
 * scripts/e2e-shards.listing.test.ts.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Project } from '@playwright/test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	ENGINES,
	GALLERY,
	galleryMode,
	GROUPS,
	IPHONE_15,
	LEGS,
	parseChoice,
	selectProjects,
	type Engine,
	type Group
} from '../e2e/projects.ts';
import { SERIAL_WORKERS } from '../e2e/serial-workers.ts';
import { parseListing, type Listing } from './journey-map.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const SELECTION = [
	'E2E_WEBKIT',
	'E2E_SERIAL_ALONE',
	'E2E_PERF_ALONE',
	'E2E_ENGINE',
	'E2E_GROUP',
	'E2E_GALLERY'
];

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

/** Each leg's projects, as selectProjects keeps them from today's whole list. */
const SELECTED: Record<string, string[]> = {
	'main/chromium': ['setup', 'iphone-chromium', 'desktop-chromium'],
	'main/webkit': ['setup', 'setup-webkit', 'iphone-webkit'],
	'serial/chromium': ['setup', 'serial-chromium'],
	'serial/webkit': ['setup', 'setup-webkit', 'serial-webkit'],
	'alone/chromium': ['setup', 'perf'],
	'exclusive/chromium': ['setup', 'exclusive']
};

/**
 * Each leg's projects as CI loads the config for it: a serial·chromium leg, which runs a worker
 * per owner world, also copies the world the setups made into the others first (`setup-worlds`,
 * e2e/worlds.ts). serial·webkit runs one worker, so one world (e2e/serial-workers.ts).
 */
const EXPECTED: Record<string, string[]> = {
	...SELECTED,
	'serial/chromium': ['setup', 'setup-worlds', 'serial-chromium']
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
			SELECTED[`${group}/${engine}`]
		);
	});

	it('keeps the order: setup first, serial, perf and exclusive after it', () => {
		const chromium = selectProjects(projects, { engine: 'chromium', group: 'serial' });
		expect(after(chromium, 'serial-chromium')).toEqual(['setup']);
		const alone = selectProjects(projects, { engine: 'chromium', group: 'alone' });
		expect(after(alone, 'perf')).toEqual(['setup']);
		const exclusive = selectProjects(projects, { engine: 'chromium', group: 'exclusive' });
		expect(after(exclusive, 'exclusive')).toEqual(['setup']);

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

	it('leaves nothing depending on a leg\u2019s projects, so a shard list splits them', () => {
		for (const leg of LEGS) {
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

	// One worker per owner world (e2e/worlds.ts): the serial specs follow the world copy, which
	// follows the setups, and run SERIAL_WORKERS.chromium at a time.
	it('runs a serial chromium leg on its owner worlds, after the copy', async () => {
		const projects = await configProjects({ E2E_ENGINE: 'chromium', E2E_GROUP: 'serial' });
		const serial = projects.find((p) => p.name === 'serial-chromium')!;
		expect(SERIAL_WORKERS.chromium).toBeGreaterThan(1);
		expect(serial.workers).toBe(SERIAL_WORKERS.chromium);
		expect(serial.dependencies).toEqual(['setup-worlds']);
		const copy = projects.find((p) => p.name === 'setup-worlds')!;
		expect(copy.testMatch).toBe('**/worlds.setup.ts');
		expect(copy.dependencies).toEqual(['setup']);
		expect(after(projects, 'serial-chromium')).toEqual(['setup', 'setup-worlds']);
	});

	// WebKit's heavy serial tests outgrew their timeout two to a runner (e2e/serial-workers.ts):
	// its serial leg runs one spec at a time in its one world, after the setups, with no copy.
	it('runs a serial webkit leg on one worker in one owner world', async () => {
		const projects = await configProjects({ E2E_ENGINE: 'webkit', E2E_GROUP: 'serial' });
		expect(SERIAL_WORKERS.webkit).toBe(1);
		expect(names(projects)).not.toContain('setup-worlds');
		const serial = projects.find((p) => p.name === 'serial-webkit')!;
		expect(serial.workers).toBe(1);
		expect(after(projects, 'serial-webkit')).toEqual(['setup', 'setup-webkit']);
	});

	it('keeps one owner world, and one serial spec at a time, outside a serial CI leg', async () => {
		for (const env of [{}, { E2E_GROUP: 'main' }, { E2E_GROUP: 'alone' }] as Record<
			string,
			string
		>[]) {
			const projects = await configProjects(env);
			expect(names(projects), JSON.stringify(env)).not.toContain('setup-worlds');
			for (const p of projects.filter((p) => p.name!.startsWith('serial-'))) {
				expect(p.workers, p.name).toBe(1);
			}
		}
		await configProjects({ E2E_GROUP: 'serial' });
		vi.resetModules();
		vi.stubEnv('CI', '');
		const { default: local } = await import('../playwright.config.ts');
		expect(names(local.projects ?? [])).not.toContain('setup-worlds');
	});

	it('adds WebKit outside CI when E2E_ENGINE=webkit', async () => {
		const projects = await configProjects({ E2E_ENGINE: 'webkit', E2E_GROUP: 'main' });
		vi.resetModules();
		vi.stubEnv('CI', '');
		const { default: config } = await import('../playwright.config.ts');
		expect(names(config.projects ?? [])).toEqual(names(projects));
	});

	// main legs run whole files side by side on 2 workers, as every local run does; serial legs one
	// per owner world (e2e/serial-workers.ts: 2 on Chromium, 1 on WebKit); every other leg (and the
	// whole suite in one CI job) keeps 1.
	it.each([
		['main', 'chromium', 2],
		['serial', 'chromium', SERIAL_WORKERS.chromium],
		['serial', 'webkit', SERIAL_WORKERS.webkit],
		['serial', '', 1],
		['alone', 'chromium', 1],
		['exclusive', 'chromium', 1],
		['sweeps', 'chromium', 1],
		['', '', 1]
	] as const)(
		'gives E2E_GROUP=%j E2E_ENGINE=%j %i worker(s) in CI',
		async (group, engine, workers) => {
			await configProjects({ E2E_GROUP: group, E2E_ENGINE: engine });
			const { default: config } = await import('../playwright.config.ts');
			expect(config.workers).toBe(workers);
		}
	);

	it('keeps 2 workers outside CI', async () => {
		await configProjects({ E2E_GROUP: 'serial' });
		vi.resetModules();
		vi.stubEnv('CI', '');
		const { default: config } = await import('../playwright.config.ts');
		expect(config.workers).toBe(2);
	});
});

describe('the screen gallery (E2E_GALLERY=1)', () => {
	afterEach(() => vi.unstubAllEnvs());
	const galleryNamed = (projects: Project[]) =>
		projects.filter((p) => p.name!.startsWith('gallery') || [p.testMatch].flat().includes(GALLERY));

	it('is in no other run: no project of today’s suite or of a leg matches a gallery spec', async () => {
		expect(galleryNamed(await configProjects())).toEqual([]);
		for (const { engine, group } of LEGS) {
			expect(galleryNamed(await configProjects({ E2E_ENGINE: engine, E2E_GROUP: group }))).toEqual(
				[]
			);
		}
	});

	it('runs the owner setups, then the gallery on an iPhone 15 in WebKit and a desktop in Chromium, on one worker', async () => {
		const projects = await configProjects({ E2E_GALLERY: '1' });
		expect(names(projects)).toEqual([
			'setup',
			'setup-webkit',
			'gallery-iphone-webkit',
			'gallery-desktop-chromium'
		]);
		const { default: config } = await import('../playwright.config.ts');
		expect(config.workers).toBe(1);
		const [iphone, desktop] = projects.slice(2);
		for (const project of [iphone!, desktop!]) {
			expect(project.testMatch, project.name).toBe(GALLERY);
			expect(project.retries, project.name).toBe(0);
		}
		expect(iphone!.metadata).toEqual({ galleryDevice: 'iphone' });
		expect(iphone!.dependencies).toEqual(['setup-webkit']);
		expect(iphone!.use).toMatchObject({
			browserName: 'webkit',
			viewport: IPHONE_15,
			deviceScaleFactor: 3,
			isMobile: true,
			hasTouch: true,
			storageState: 'e2e/.auth/webkit.json'
		});
		expect(desktop!.metadata).toEqual({ galleryDevice: 'desktop' });
		expect(desktop!.dependencies).toEqual(['setup']);
		expect(desktop!.use).toMatchObject({
			browserName: 'chromium',
			viewport: { width: 1440, height: 900 },
			deviceScaleFactor: 1,
			isMobile: false,
			storageState: 'e2e/.auth/chromium.json'
		});
		// Outside CI too: the gallery keeps WebKit and one worker.
		vi.resetModules();
		vi.stubEnv('CI', '');
		const { default: local } = await import('../playwright.config.ts');
		expect(names(local.projects ?? [])).toEqual(names(projects));
		expect(local.workers).toBe(1);
	});

	it('is a run of its own: it refuses a leg’s selection and the deployed targets', () => {
		expect(galleryMode({})).toBe(false);
		expect(galleryMode({ E2E_GALLERY: '0' })).toBe(false);
		expect(galleryMode({ E2E_GALLERY: '1' })).toBe(true);
		for (const name of ['E2E_ENGINE', 'E2E_GROUP', 'E2E_BASE_URL', 'E2E_DEPLOYED_LOCAL']) {
			expect(() => galleryMode({ E2E_GALLERY: '1', [name]: 'x' }), name).toThrow(
				new RegExp(`unset ${name}`)
			);
		}
	});
});

/** `playwright test --list` for one leg (or today's whole suite), as CI loads the config. */
function list(
	leg: { engine?: Engine; group?: Group } = {},
	extra: Record<string, string> = {}
): Listing {
	const env: NodeJS.ProcessEnv = { CI: '1' };
	for (const [name, value] of Object.entries(process.env)) {
		if (!/^(E2E_|PLAYWRIGHT_JSON_|CI$)/.test(name)) env[name] = value;
	}
	if (leg.engine) env.E2E_ENGINE = leg.engine;
	if (leg.group) env.E2E_GROUP = leg.group;
	Object.assign(env, extra);
	const args = ['exec', 'playwright', 'test', '--list', '--reporter=json'];
	const run = spawnSync('pnpm', args, {
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
				// The world copy is serial·chromium's own setup, which one world needs none of.
				return runs(listing).filter((run) => !run.startsWith('setup-worlds › '));
			})
		);
		expect(today.size).toBeGreaterThan(0);
		expect([...legs].sort()).toEqual([...today].sort());
	}, 120_000);

	it('never list the gallery spec, which only E2E_GALLERY=1 lists, on both gallery devices', () => {
		const isGallery = (run: string) => run.includes('.gallery.ts');
		expect(runs(listed()).filter(isGallery)).toEqual([]);
		for (const leg of LEGS) expect(runs(listed(leg)).filter(isGallery)).toEqual([]);

		const gallery = beyondSetup(runs(list({}, { E2E_GALLERY: '1' })));
		expect(gallery.length).toBeGreaterThan(0);
		expect(gallery.filter((run) => !isGallery(run))).toEqual([]);
		const perProject = (project: string) =>
			gallery
				.filter((run) => run.startsWith(`${project} › `))
				.map((run) => run.slice(project.length));
		expect(perProject('gallery-iphone-webkit').length).toBeGreaterThan(0);
		expect(perProject('gallery-desktop-chromium')).toEqual(perProject('gallery-iphone-webkit'));
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
});
