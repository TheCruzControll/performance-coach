/**
 * e2e/projects.ts e2eProjects: the four target modes. `local`
 * and `external-local` run the full project list; `deployed` and `local-deployed` run only the
 * target check and the signed-out smoke projects, which a deployed run never retries and which
 * gain the Chromium golden path when it is given a setup token. Every mode composes with one CI
 * leg's E2E_ENGINE and E2E_GROUP, and the Vercel bypass header goes out only with its secret.
 * E2E_TLS=1 (local and local-deployed only) serves https://localhost: Chromium trusts the proxy
 * certificate's SPKI at launch, and every project ignores certificate errors.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Project } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	bypassHeaders,
	e2eBaseURL,
	e2eMode,
	e2eProjects,
	selectProjects,
	SMOKE,
	TARGET_CHECK,
	tlsEnabled,
	withTls,
	type E2EEnv
} from '../e2e/projects.ts';
import { ensureCertificate } from './e2e-tls/cert.ts';
import { parseListing } from './journey-map.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const TARGET = [
	'E2E_BASE_URL',
	'E2E_TEST_AUTH',
	'E2E_DEPLOYED_LOCAL',
	'E2E_SETUP_TOKEN',
	'E2E_BYPASS_SECRET',
	'E2E_WEBKIT',
	'E2E_SERIAL_ALONE',
	'E2E_PERF_ALONE',
	'E2E_ENGINE',
	'E2E_GROUP',
	'E2E_TLS',
	'E2E_PORT',
	'E2E_TLS_SPKI',
	'TEST_WORKER_INDEX'
];
const URL_ = 'https://coach.example.com';
const SMOKES = [
	'smoke-iphone-chromium',
	'smoke-iphone-webkit',
	'smoke-desktop-chromium',
	'smoke-desktop-webkit'
];

/** playwright.config.ts as CI loads it, with `env` on top. */
async function loadConfig(env: Record<string, string> = {}) {
	vi.resetModules(); // the config reads the environment when it loads
	vi.stubEnv('CI', '1');
	for (const name of TARGET) vi.stubEnv(name, '');
	for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
	return (await import('../playwright.config.ts')).default;
}

/** A small local list in the config's shape. */
function local(): Project[] {
	return [
		{ name: 'setup', use: { browserName: 'chromium' } },
		{ name: 'iphone-chromium', dependencies: ['setup'], use: { browserName: 'chromium' } },
		{ name: 'setup-webkit', dependencies: ['setup'], use: { browserName: 'webkit' } },
		{ name: 'iphone-webkit', dependencies: ['setup-webkit'], use: { browserName: 'webkit' } },
		{
			name: 'serial-chromium',
			dependencies: ['iphone-chromium', 'iphone-webkit'],
			use: { browserName: 'chromium' }
		}
	];
}

const shape = (projects: Project[]) =>
	projects.map((p) => ({
		name: p.name,
		dependencies: p.dependencies ?? [],
		testMatch: p.testMatch,
		testIgnore: p.testIgnore
	}));
/** A project's browser options (`Project` leaves them untyped). */
const use = (project: Project) =>
	(project.use ?? {}) as {
		storageState?: unknown;
		browserName?: string;
		viewport?: { width: number };
	};
const names = (projects: Project[]) => projects.map((p) => p.name);
const deployed: E2EEnv = { E2E_BASE_URL: URL_ };
const localDeployed: E2EEnv = { E2E_DEPLOYED_LOCAL: '1' };

describe('e2eMode', () => {
	it('reads the four modes from the environment', () => {
		expect(e2eMode({})).toBe('local');
		expect(e2eMode({ E2E_BASE_URL: URL_, E2E_TEST_AUTH: '1' })).toBe('external-local');
		expect(e2eMode(deployed)).toBe('deployed');
		expect(e2eMode({ ...deployed, E2E_TEST_AUTH: '0' })).toBe('deployed');
		expect(e2eMode(localDeployed)).toBe('local-deployed');
	});

	it('refuses a local-deployed run pointed at another server', () => {
		expect(() => e2eMode({ ...localDeployed, E2E_BASE_URL: URL_ })).toThrow(/unset E2E_BASE_URL/);
	});
});

describe('e2eProjects', () => {
	afterEach(() => vi.unstubAllEnvs());

	it('local and external-local: the whole local list, unchanged', () => {
		expect(e2eProjects({}, local())).toEqual(local());
		expect(e2eProjects({ E2E_BASE_URL: URL_, E2E_TEST_AUTH: '1' }, local())).toEqual(local());
	});

	it('local: the config’s projects, as CI loads them', async () => {
		const config = await loadConfig();
		expect(shape(config.projects!)).toMatchInlineSnapshot(`
			[
			  {
			    "dependencies": [],
			    "name": "setup",
			    "testIgnore": undefined,
			    "testMatch": "**/auth.setup.ts",
			  },
			  {
			    "dependencies": [
			      "setup",
			    ],
			    "name": "iphone-chromium",
			    "testIgnore": [
			      "**/perf.e2e.ts",
			      "**/perf-*.e2e.ts",
			      "**/*.exclusive.e2e.ts",
			      "**/*.serial.e2e.ts",
			      "**/*.sweep.e2e.ts",
			      "**/*.desktop.e2e.ts",
			    ],
			    "testMatch": undefined,
			  },
			  {
			    "dependencies": [
			      "setup",
			    ],
			    "name": "desktop-chromium",
			    "testIgnore": [
			      "**/perf.e2e.ts",
			      "**/perf-*.e2e.ts",
			      "**/*.exclusive.e2e.ts",
			      "**/*.serial.e2e.ts",
			      "**/*.sweep.e2e.ts",
			    ],
			    "testMatch": [
			      "**/*.desktop.e2e.ts",
			      "**/shell.e2e.ts",
			      "**/offline.e2e.ts",
			      "**/a11y-*.e2e.ts",
			      "**/*.smoke.e2e.ts",
			    ],
			  },
			  {
			    "dependencies": [
			      "serial-webkit",
			    ],
			    "name": "perf",
			    "testIgnore": undefined,
			    "testMatch": [
			      "**/perf.e2e.ts",
			      "**/perf-*.e2e.ts",
			    ],
			  },
			  {
			    "dependencies": [
			      "setup",
			    ],
			    "name": "setup-webkit",
			    "testIgnore": undefined,
			    "testMatch": "**/auth-webkit.setup.ts",
			  },
			  {
			    "dependencies": [
			      "setup-webkit",
			    ],
			    "name": "iphone-webkit",
			    "testIgnore": [
			      "**/perf.e2e.ts",
			      "**/perf-*.e2e.ts",
			      "**/*.exclusive.e2e.ts",
			      "**/*.serial.e2e.ts",
			      "**/*.sweep.e2e.ts",
			      "**/*.desktop.e2e.ts",
			    ],
			    "testMatch": undefined,
			  },
			  {
			    "dependencies": [
			      "iphone-chromium",
			      "desktop-chromium",
			      "iphone-webkit",
			    ],
			    "name": "serial-chromium",
			    "testIgnore": undefined,
			    "testMatch": "**/*.serial.e2e.ts",
			  },
			  {
			    "dependencies": [
			      "serial-chromium",
			    ],
			    "name": "serial-webkit",
			    "testIgnore": undefined,
			    "testMatch": "**/*.serial.e2e.ts",
			  },
			  {
			    "dependencies": [
			      "iphone-chromium",
			      "desktop-chromium",
			      "perf",
			      "iphone-webkit",
			      "serial-chromium",
			      "serial-webkit",
			    ],
			    "name": "sweep-chromium",
			    "testIgnore": undefined,
			    "testMatch": "**/*.sweep.e2e.ts",
			  },
			  {
			    "dependencies": [
			      "setup-webkit",
			      "sweep-chromium",
			    ],
			    "name": "sweep-webkit",
			    "testIgnore": undefined,
			    "testMatch": "**/*.sweep.e2e.ts",
			  },
			  {
			    "dependencies": [
			      "iphone-chromium",
			      "desktop-chromium",
			      "perf",
			      "iphone-webkit",
			      "serial-chromium",
			      "serial-webkit",
			      "sweep-chromium",
			      "sweep-webkit",
			    ],
			    "name": "exclusive",
			    "testIgnore": undefined,
			    "testMatch": "**/*.exclusive.e2e.ts",
			  },
			]
		`);
	});

	it('deployed: the target check, then the smoke on an iPhone and a desktop in both engines, signed out, never retried', () => {
		const projects = e2eProjects(deployed, local());
		expect(names(projects)).toEqual([TARGET_CHECK, ...SMOKES]);
		expect(projects[0]).toMatchObject({ testMatch: '**/deployed-setup.ts', retries: 0 });
		for (const project of projects.slice(1)) {
			expect(project, project.name).toMatchObject({
				testMatch: SMOKE,
				dependencies: [TARGET_CHECK],
				retries: 0
			});
			expect(use(project).storageState, project.name).toBeUndefined();
			expect(use(project).browserName, project.name).toBe(project.name!.split('-')[2]);
			const width = use(project).viewport?.width;
			expect(width, project.name).toBe(project.name!.includes('desktop') ? 1440 : 393);
		}
	});

	it('deployed with E2E_SETUP_TOKEN: adds the Chromium golden path, tagged @deployed-journey', () => {
		const projects = e2eProjects({ ...deployed, E2E_SETUP_TOKEN: 'token' }, local());
		expect(names(projects)).toEqual([TARGET_CHECK, ...SMOKES, 'deployed-journey']);
		const journey = projects.at(-1)!;
		expect(journey).toMatchObject({ dependencies: [TARGET_CHECK], retries: 0 });
		expect(use(journey).browserName).toBe('chromium');
		expect(journey.grep).toEqual(/@deployed-journey/);
		expect((journey.grep as RegExp).test('a journey @deployed-journey')).toBe(true);
	});

	it('local-deployed: the same smoke against the local build, keeping the CI retry, no golden path', () => {
		const projects = e2eProjects({ ...localDeployed, E2E_SETUP_TOKEN: 'token' }, local());
		expect(names(projects)).toEqual([TARGET_CHECK, ...SMOKES]);
		for (const project of projects) expect(project.retries, project.name).toBeUndefined();
	});

	it('composes with one CI leg’s E2E_ENGINE and E2E_GROUP in every mode', () => {
		for (const env of [deployed, localDeployed]) {
			const webkit = e2eProjects({ ...env, E2E_ENGINE: 'webkit' }, local());
			expect(names(webkit)).toEqual([TARGET_CHECK, 'smoke-iphone-webkit', 'smoke-desktop-webkit']);
			expect(webkit.slice(1).map((p) => p.dependencies)).toEqual([[TARGET_CHECK], [TARGET_CHECK]]);
			expect(names(e2eProjects({ ...env, E2E_GROUP: 'main' }, local()))).toEqual([
				TARGET_CHECK,
				...SMOKES
			]);
			expect(names(e2eProjects({ ...env, E2E_GROUP: 'serial' }, local()))).toEqual([TARGET_CHECK]);
		}
		const selection = { engine: 'webkit', group: 'serial' } as const;
		for (const env of [{}, { E2E_BASE_URL: URL_, E2E_TEST_AUTH: '1' }]) {
			expect(e2eProjects({ ...env, E2E_ENGINE: 'webkit', E2E_GROUP: 'serial' }, local())).toEqual(
				selectProjects(local(), selection)
			);
		}
		expect(() => e2eProjects({ ...deployed, E2E_ENGINE: 'firefox' }, local())).toThrow(
			/E2E_ENGINE=firefox/
		);
	});

	it('the config applies the mode: E2E_BASE_URL alone loads only the smoke projects', async () => {
		const config = await loadConfig({ E2E_BASE_URL: URL_ });
		expect(names(config.projects!)).toEqual([TARGET_CHECK, ...SMOKES]);
		expect(config.use?.baseURL).toBe(URL_);
	});

	it('lists exactly the smoke specs in every smoke project of a deployed run', () => {
		const env: NodeJS.ProcessEnv = { CI: '1', E2E_BASE_URL: URL_ };
		for (const [name, value] of Object.entries(process.env)) {
			if (!/^(E2E_|PLAYWRIGHT_JSON_|CI$)/.test(name)) env[name] = value;
		}
		const run = spawnSync('pnpm', ['exec', 'playwright', 'test', '--list', '--reporter=json'], {
			cwd: root,
			env,
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024
		});
		expect(run.status, run.stderr).toBe(0);
		const listing = parseListing(JSON.parse(run.stdout));
		const files = (project: string) =>
			[...listing.tests]
				.filter(([, projects]) => projects.has(project))
				.map(([key]) => key.split(' › ')[0]!);
		expect(new Set(files(TARGET_CHECK))).toEqual(new Set(['deployed-setup.ts']));
		for (const project of SMOKES) {
			const listed = files(project);
			expect(listed.length, project).toBeGreaterThan(0);
			for (const file of listed) expect(file, project).toMatch(/\.smoke\.e2e\.ts$/);
		}
	}, 120_000);
});

describe('E2E_TLS', () => {
	afterEach(() => vi.unstubAllEnvs());
	const SPKI = 'c3BraS1oYXNo';
	const flag = `--ignore-certificate-errors-spki-list=${SPKI}`;
	const launchArgs = (project: Project) =>
		((project.use ?? {}) as { launchOptions?: { args?: string[] } }).launchOptions?.args ?? [];

	it('serves https://localhost on E2E_PORT in the modes that start a server, and refuses the others', () => {
		expect(e2eBaseURL({})).toBe('http://localhost:4173');
		expect(e2eBaseURL({ E2E_PORT: '5324' })).toBe('http://localhost:5324');
		expect(e2eBaseURL({ E2E_TLS: '1', E2E_PORT: '5324' })).toBe('https://localhost:5324');
		expect(e2eBaseURL({ ...localDeployed, E2E_TLS: '1' })).toBe('https://localhost:4173');
		expect(e2eBaseURL(deployed)).toBe(URL_);
		expect(tlsEnabled({ E2E_TLS: '0' })).toBe(false);
		expect(() => tlsEnabled({ ...deployed, E2E_TLS: '1' })).toThrow(/deployed mode starts none/);
		expect(() => tlsEnabled({ E2E_BASE_URL: URL_, E2E_TEST_AUTH: '1', E2E_TLS: '1' })).toThrow(
			/external-local/
		);
	});

	it('Chromium trusts the certificate’s key at launch; every project ignores HTTPS errors', () => {
		const chromium: Project = {
			name: 'iphone-chromium',
			use: { browserName: 'chromium', launchOptions: { args: ['--keep'], slowMo: 5 } }
		};
		const webkit: Project = { name: 'iphone-webkit', use: { browserName: 'webkit' } };
		const [c, w] = withTls([chromium, webkit], SPKI);
		expect(use(c!)).toMatchObject({ ignoreHTTPSErrors: true, launchOptions: { slowMo: 5 } });
		expect(launchArgs(c!)).toEqual(['--keep', flag]);
		expect(use(w!)).toMatchObject({ ignoreHTTPSErrors: true, browserName: 'webkit' });
		expect(launchArgs(w!)).toEqual([]);
		expect(launchArgs(chromium)).toEqual(['--keep']); // the input is not changed
	});

	it('applies to every project of a local or local-deployed run, after the leg’s selection', () => {
		for (const env of [{ E2E_TLS: '1' }, { ...localDeployed, E2E_TLS: '1' }]) {
			const projects = e2eProjects({ ...env, E2E_ENGINE: 'chromium' }, local(), SPKI);
			expect(projects.length).toBeGreaterThan(0);
			for (const project of projects) {
				expect(use(project), project.name).toMatchObject({ ignoreHTTPSErrors: true });
				expect(launchArgs(project), project.name).toContain(flag);
			}
		}
		expect(() => e2eProjects({ E2E_TLS: '1' }, local())).toThrow(/SPKI/);
		for (const project of e2eProjects({}, local(), SPKI)) {
			expect(use(project), project.name).not.toHaveProperty('ignoreHTTPSErrors');
		}
	});

	it('the config loads with the https origin and pins the certificate global setup serves', async () => {
		const config = await loadConfig({ E2E_TLS: '1', E2E_PORT: '5324' });
		expect(config.use?.baseURL).toBe('https://localhost:5324');
		const { spki } = ensureCertificate();
		const chromium = config.projects!.find((p) => p.name === 'iphone-chromium')!;
		expect(launchArgs(chromium)).toContain(`--ignore-certificate-errors-spki-list=${spki}`);
		const webkit = config.projects!.find((p) => p.name === 'iphone-webkit')!;
		expect(use(webkit)).toMatchObject({ ignoreHTTPSErrors: true });
	});

	it('a worker pins the SPKI the runner exported, never a certificate of its own', async () => {
		await loadConfig({ E2E_TLS: '1' });
		expect(process.env.E2E_TLS_SPKI).toBe(ensureCertificate().spki);
		const config = await loadConfig({ E2E_TLS: '1', E2E_TLS_SPKI: SPKI, TEST_WORKER_INDEX: '0' });
		const chromium = config.projects!.find((p) => p.name === 'iphone-chromium')!;
		expect(launchArgs(chromium)).toContain(flag);
	});

	it('the runner replaces a stale E2E_TLS_SPKI left in the shell with the served certificate', async () => {
		const config = await loadConfig({ E2E_TLS: '1', E2E_TLS_SPKI: SPKI });
		const { spki } = ensureCertificate();
		expect(process.env.E2E_TLS_SPKI).toBe(spki);
		const chromium = config.projects!.find((p) => p.name === 'iphone-chromium')!;
		expect(launchArgs(chromium)).toContain(`--ignore-certificate-errors-spki-list=${spki}`);
	});
});

describe('bypassHeaders', () => {
	afterEach(() => vi.unstubAllEnvs());

	it('sends the Vercel bypass headers only with the secret, and only to an external target', () => {
		expect(bypassHeaders({ E2E_BASE_URL: URL_ })).toBeUndefined();
		expect(bypassHeaders({ E2E_BYPASS_SECRET: 's3cret' })).toBeUndefined();
		expect(bypassHeaders({ E2E_BASE_URL: URL_, E2E_BYPASS_SECRET: 's3cret' })).toEqual({
			'x-vercel-protection-bypass': 's3cret',
			'x-vercel-set-bypass-cookie': 'true'
		});
	});

	it('reaches the config’s extraHTTPHeaders only when the secret is set', async () => {
		expect((await loadConfig({ E2E_BASE_URL: URL_ })).use?.extraHTTPHeaders).toBeUndefined();
		const withSecret = await loadConfig({ E2E_BASE_URL: URL_, E2E_BYPASS_SECRET: 's3cret' });
		expect(withSecret.use?.extraHTTPHeaders).toMatchObject({
			'x-vercel-protection-bypass': 's3cret'
		});
	});
});
