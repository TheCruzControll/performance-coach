/**
 * Which Playwright projects one CI leg runs (pure; playwright.config.ts applies it).
 *
 * CI splits the browser suite into parallel legs, one per group and engine, each with its own
 * Postgres, database and production server (.github/workflows/ci.yml). A leg keeps:
 * - one engine's projects: `chromium` or `webkit` (the project's `use.browserName`);
 * - one group's projects (groupOf): `main`, the functional specs; `serial`, the specs that run
 *   one at a time after them (serial-*); `alone`, perf, which must have the leg to itself, and
 *   `exclusive`, whose specs end the sessions other specs use (both Chromium only); `sweeps`, the
 *   heavy sweep-* projects;
 * - the setup projects it needs: `setup` (the Chromium owner setup) always, `setup-webkit` with
 *   WebKit.
 * A kept project's dependency on a removed one becomes a dependency on that project's nearest kept
 * ancestors, so serial still follows setup.
 *
 * Why `serial`, `alone` and `exclusive` are legs of their own: Playwright's `--shard` splits only
 * top-level projects and runs every dependency project in full in every shard. The functional
 * projects are dependencies of the serial ones, serial-chromium of perf and perf of exclusive, so a
 * leg holding two of them could never shard: any shard with an exclusive test would run all of
 * perf first. Apart, each leg's projects are top-level and shard on their own.
 *
 * With neither engine nor group set (a local run), the list comes back unchanged.
 */
import { devices, type LaunchOptions, type Project } from '@playwright/test';
import { DESKTOP } from './desktop';

export const ENGINES = ['chromium', 'webkit'] as const;
export const GROUPS = ['main', 'serial', 'alone', 'exclusive', 'sweeps'] as const;
export type Engine = (typeof ENGINES)[number];
export type Group = (typeof GROUPS)[number];

/** The groups whose specs run on Chromium alone (CDP throttling, the virtual authenticator). */
const CHROMIUM_ONLY: readonly Group[] = ['alone', 'exclusive'];

/**
 * The legs CI runs (.github/workflows/ci.yml): every group on both engines, `alone` and
 * `exclusive` on Chromium.
 * `sweeps` has no leg until a *.sweep.e2e.ts spec exists: its legs would run only the setup the
 * other legs already run. The legs' --list union test (scripts/e2e-projects.test.ts) fails the
 * day a sweep spec lands without them.
 */
export const LEGS: readonly { group: Group; engine: Engine }[] = GROUPS.filter(
	(group) => group !== 'sweeps'
).flatMap((group) =>
	(CHROMIUM_ONLY.includes(group) ? (['chromium'] as const) : ENGINES).map((engine) => ({
		group,
		engine
	}))
);

/** The owner setup every leg starts from; it runs on Chromium even in a WebKit leg. */
const OWNER_SETUP = 'setup';
/** A deployed run's target check (e2e/deployed-setup.ts): HTTP only, so every leg keeps it too. */
export const TARGET_CHECK = 'deployed-setup';

/** The group a (non-setup) project belongs to, by name. */
export function groupOf(name: string): Group {
	if (name.startsWith('sweep-')) return 'sweeps';
	if (name.startsWith('serial-')) return 'serial';
	if (name === 'perf') return 'alone';
	if (name === 'exclusive') return 'exclusive';
	return 'main';
}

function engineOf(project: Project): Engine {
	const browserName = (project.use as { browserName?: unknown } | undefined)?.browserName;
	if (!ENGINES.includes(browserName as Engine)) {
		throw new Error(`project ${project.name}: unknown browserName ${String(browserName)}`);
	}
	return browserName as Engine;
}

/** Reads a selection value, refusing anything outside `allowed` (unset or empty is `undefined`). */
export function parseChoice<T extends string>(
	variable: string,
	value: string | undefined,
	allowed: readonly T[]
): T | undefined {
	if (!value) return undefined;
	if (!allowed.includes(value as T)) {
		throw new Error(`${variable}=${value}: expected one of ${allowed.join(', ')}`);
	}
	return value as T;
}

export function selectProjects(
	projects: readonly Project[],
	{ engine, group }: { engine?: Engine; group?: Group }
): Project[] {
	const byName = new Map(projects.map((p) => [p.name!, p]));
	const keeps = (project: Project) => {
		const name = project.name!;
		const projectEngine = engineOf(project);
		if (name === OWNER_SETUP || name === TARGET_CHECK) return true;
		if (engine && projectEngine !== engine) return false;
		if (name.startsWith('setup')) return true;
		return !group || groupOf(name) === group;
	};
	if (!engine && !group) {
		for (const project of projects) engineOf(project);
		return [...projects];
	}
	const kept = new Set(projects.filter(keeps).map((p) => p.name!));

	/** `name` itself when kept, else the nearest kept ancestors through its dependencies. */
	const nearestKept = (name: string): string[] => {
		if (kept.has(name)) return [name];
		const project = byName.get(name);
		if (!project) throw new Error(`unknown dependency ${name}`);
		return (project.dependencies ?? []).flatMap(nearestKept);
	};

	return projects
		.filter((p) => kept.has(p.name!))
		.map((project) => {
			if (!project.dependencies) return project;
			const dependencies = [...new Set(project.dependencies.flatMap(nearestKept))];
			return { ...project, dependencies };
		});
}

/**
 * What the suite runs against:
 * - `local` (the default): global-setup resets the e2e database, builds, and starts the server
 *   with test routes on;
 * - `external-local` (E2E_BASE_URL with E2E_TEST_AUTH=1): a server someone else started with test
 *   routes on, over the same database; global-setup resets and mints, but starts nothing;
 * - `deployed` (E2E_BASE_URL alone): a real deployment with test auth off. Only the signed-out,
 *   read-only smoke specs run, and nothing touches a database;
 * - `local-deployed` (E2E_DEPLOYED_LOCAL=1): the smoke specs against the production build, started
 *   locally without test routes or a setup token, on the database the main run left behind.
 */
export const MODES = ['local', 'external-local', 'deployed', 'local-deployed'] as const;
export type Mode = (typeof MODES)[number];
export type E2EEnv = Readonly<Record<string, string | undefined>>;

export function e2eMode(env: E2EEnv): Mode {
	if (env.E2E_DEPLOYED_LOCAL === '1') {
		if (env.E2E_BASE_URL) {
			throw new Error('E2E_DEPLOYED_LOCAL=1 starts its own server: unset E2E_BASE_URL');
		}
		return 'local-deployed';
	}
	if (!env.E2E_BASE_URL) return 'local';
	return env.E2E_TEST_AUTH === '1' ? 'external-local' : 'deployed';
}

/** The read-only, signed-out specs a deployed target runs (the local projects run them too). */
export const SMOKE = '**/*.smoke.e2e.ts';
/** The tag a deployed run's signed-in golden path carries (`{ tag: '@deployed-journey' }`). */
export const DEPLOYED_JOURNEY_TAG = '@deployed-journey';

/**
 * A deployed or local-deployed run's projects: the target check, then the smoke specs on an
 * iPhone and a desktop window in both engines, signed out (no storage state). With
 * E2E_SETUP_TOKEN, a deployed run adds the Chromium golden path, which sets the owner up with that
 * token. A deployed run never retries: a flaky production check is a finding, not noise.
 */
function smokeProjects(mode: 'deployed' | 'local-deployed', env: E2EEnv): Project[] {
	const deployed = mode === 'deployed';
	const retries = deployed ? { retries: 0 } : {};
	const windows = {
		iphone: { chromium: devices['iPhone 15 Pro'], webkit: devices['iPhone 15 Pro'] },
		desktop: {
			chromium: { ...devices['Desktop Chrome'], ...DESKTOP },
			webkit: { ...devices['Desktop Safari'], ...DESKTOP }
		}
	} as const;
	const projects: Project[] = [
		{
			name: TARGET_CHECK,
			testMatch: '**/deployed-setup.ts',
			...retries,
			use: { browserName: 'chromium' }
		}
	];
	for (const size of ['iphone', 'desktop'] as const) {
		for (const engine of ENGINES) {
			projects.push({
				name: `smoke-${size}-${engine}`,
				testMatch: SMOKE,
				dependencies: [TARGET_CHECK],
				...retries,
				use: { ...windows[size][engine], browserName: engine }
			});
		}
	}
	if (deployed && env.E2E_SETUP_TOKEN) {
		projects.push({
			name: 'deployed-journey',
			grep: new RegExp(DEPLOYED_JOURNEY_TAG),
			dependencies: [TARGET_CHECK],
			...retries,
			use: { ...windows.iphone.chromium, browserName: 'chromium' }
		});
	}
	return projects;
}

/**
 * The projects this run executes (playwright.config.ts): `local` for the local and external-local
 * modes, the smoke projects for the deployed ones, then one CI leg's share of them (E2E_ENGINE,
 * E2E_GROUP; selectProjects), served through the TLS proxy's certificate with E2E_TLS=1 (withTls).
 */
export function e2eProjects(env: E2EEnv, local: readonly Project[], spki?: string): Project[] {
	const mode = e2eMode(env);
	const engine = parseChoice('E2E_ENGINE', env.E2E_ENGINE, ENGINES);
	const group = parseChoice('E2E_GROUP', env.E2E_GROUP, GROUPS);
	const projects = mode === 'local' || mode === 'external-local' ? local : smokeProjects(mode, env);
	const selected = selectProjects(projects, { engine, group });
	if (!tlsEnabled(env)) return selected;
	if (!spki) throw new Error('E2E_TLS=1: the proxy certificate’s SPKI hash is missing');
	return withTls(selected, spki);
}

/**
 * Vercel's Protection Bypass for Automation (E2E_BYPASS_SECRET), as extra headers for a deployed
 * run, or none. Accepted deviation from "app origin only": they are context-wide
 * extraHTTPHeaders, so a navigation or redirect off the origin would carry them too. The smoke
 * specs request relative paths only and the app's CSP (default-src 'self') keeps its fetches on
 * its origin; a context.route would scope them exactly, but on WebKit page.route misses requests
 * from a page the service worker controls, so the headers would go missing there instead.
 */
export function bypassHeaders(env: E2EEnv): Record<string, string> | undefined {
	const secret = env.E2E_BYPASS_SECRET;
	if (!secret || !env.E2E_BASE_URL) return undefined;
	return { 'x-vercel-protection-bypass': secret, 'x-vercel-set-bypass-cookie': 'true' };
}

/** The port a local run serves on (E2E_PORT), the TLS proxy's when E2E_TLS=1. */
export const DEFAULT_E2E_PORT = 4173;

/**
 * Whether the run is served over HTTPS through the local TLS proxy (scripts/e2e-tls): E2E_TLS=1,
 * in the modes that start their own server. A deployed or external target has its own TLS.
 */
export function tlsEnabled(env: E2EEnv): boolean {
	if (env.E2E_TLS !== '1') return false;
	const mode = e2eMode(env);
	if (mode !== 'local' && mode !== 'local-deployed') {
		throw new Error(`E2E_TLS=1 serves a server this run starts; the ${mode} mode starts none`);
	}
	return true;
}

/**
 * The screen gallery (.github/workflows/screen-gallery.yml): E2E_GALLERY=1 runs only the
 * `*.gallery.ts` specs, which no other run lists (the config's testMatch is `*.e2e.ts`), so the
 * gallery adds nothing to a CI leg or a shard plan. It is a whole run of its own: it refuses a
 * leg's selection and the deployed targets.
 */
export const GALLERY = '**/*.gallery.ts';

export function galleryMode(env: E2EEnv): boolean {
	if (env.E2E_GALLERY !== '1') return false;
	for (const name of ['E2E_ENGINE', 'E2E_GROUP', 'E2E_BASE_URL', 'E2E_DEPLOYED_LOCAL']) {
		if (env[name]) throw new Error(`E2E_GALLERY=1 is a run of its own: unset ${name}`);
	}
	return true;
}

/** The app's origin under test: E2E_BASE_URL, else localhost on E2E_PORT, over HTTPS with E2E_TLS. */
export function e2eBaseURL(env: E2EEnv): string {
	if (env.E2E_BASE_URL) return env.E2E_BASE_URL;
	const scheme = tlsEnabled(env) ? 'https' : 'http';
	return `${scheme}://localhost:${env.E2E_PORT || DEFAULT_E2E_PORT}`;
}

/**
 * `projects` served through the TLS proxy's self-signed certificate. Chromium trusts its public
 * key (`spki`, base64 SHA-256) at launch, so the certificate counts as valid and WebAuthn runs;
 * WebKit has no such switch and ignores the certificate error (its specs use minted sessions).
 * Both set ignoreHTTPSErrors, which also covers the Node-side `request` contexts; on Chromium it
 * has nothing to ignore once the key is trusted.
 */
export function withTls(projects: readonly Project[], spki: string): Project[] {
	return projects.map((project) => {
		const use: { ignoreHTTPSErrors: boolean; launchOptions?: LaunchOptions } = {
			...project.use,
			ignoreHTTPSErrors: true
		};
		if (engineOf(project) === 'chromium') {
			const launchOptions = use.launchOptions ?? {};
			use.launchOptions = {
				...launchOptions,
				args: [...(launchOptions.args ?? []), `--ignore-certificate-errors-spki-list=${spki}`]
			};
		}
		return { ...project, use };
	});
}

/** iPhone 15's screen in CSS pixels: the gallery captures the phone at its full height. */
export const IPHONE_15 = { width: 393, height: 852 } as const;

/**
 * The gallery's projects: the owner setups, then the gallery specs on an iPhone 15 in WebKit (at
 * 3x) and a 1440 × 900 desktop window in Chromium, each signed in from its engine's setup. A
 * screen that fails is recorded by the spec, never retried; `metadata.galleryDevice` names the
 * device in each file name.
 */
export function galleryProjects({
	setup,
	setupWebKit,
	chromiumState,
	webkitState
}: {
	setup: Project;
	setupWebKit: Project;
	chromiumState: string;
	webkitState: string;
}): Project[] {
	const gallery = { testMatch: GALLERY, retries: 0, fullyParallel: false } as const;
	const timeouts = { actionTimeout: 10_000, navigationTimeout: 20_000 } as const;
	return [
		setup,
		setupWebKit,
		{
			name: 'gallery-iphone-webkit',
			...gallery,
			dependencies: [setupWebKit.name!],
			metadata: { galleryDevice: 'iphone' },
			use: {
				...devices['iPhone 15'],
				viewport: IPHONE_15,
				contextOptions: { screen: IPHONE_15 },
				deviceScaleFactor: 3,
				browserName: 'webkit',
				storageState: webkitState,
				...timeouts
			}
		},
		{
			name: 'gallery-desktop-chromium',
			...gallery,
			dependencies: [setup.name!],
			metadata: { galleryDevice: 'desktop' },
			use: {
				...devices['Desktop Chrome'],
				...DESKTOP,
				browserName: 'chromium',
				storageState: chromiumState,
				...timeouts
			}
		}
	];
}
