/**
 * Which Playwright projects one CI leg runs (pure; playwright.config.ts applies it).
 *
 * CI splits the browser suite into parallel legs, one per group and engine, each with its own
 * Postgres, database and production server (.github/workflows/ci.yml). A leg keeps:
 * - one engine's projects: `chromium` or `webkit` (the project's `use.browserName`);
 * - one group's projects (groupOf): `main`, the functional specs; `serial`, the specs that run
 *   one at a time after them (serial-*); `alone`, perf and exclusive, which must have the leg to
 *   themselves (Chromium only); `sweeps`, the heavy sweep-* projects;
 * - the setup projects it needs: `setup` (the Chromium owner setup) always, `setup-webkit` with
 *   WebKit.
 * A kept project's dependency on a removed one becomes a dependency on that project's nearest kept
 * ancestors, so serial still follows setup and exclusive still follows perf.
 *
 * Why `serial` and `alone` are legs of their own: Playwright's `--shard` splits only top-level
 * projects and runs every dependency project in full in every shard. The functional projects are
 * dependencies of the serial ones, and serial-chromium of perf and exclusive, so a leg holding
 * both could never shard. Apart, each leg's projects are top-level and shard on their own.
 *
 * With neither engine nor group set (a local run), the list comes back unchanged.
 */
import { devices, type Project } from '@playwright/test';
import { DESKTOP } from './desktop';

export const ENGINES = ['chromium', 'webkit'] as const;
export const GROUPS = ['main', 'serial', 'alone', 'sweeps'] as const;
export type Engine = (typeof ENGINES)[number];
export type Group = (typeof GROUPS)[number];

/**
 * The legs CI runs (.github/workflows/ci.yml): every group on both engines, `alone` on Chromium.
 * `sweeps` has no leg until a *.sweep.e2e.ts spec exists: its legs would run only the setup the
 * other legs already run. The legs' --list union test (scripts/e2e-projects.test.ts) fails the
 * day a sweep spec lands without them.
 */
export const LEGS: readonly { group: Group; engine: Engine }[] = GROUPS.filter(
	(group) => group !== 'sweeps'
).flatMap((group) =>
	(group === 'alone' ? (['chromium'] as const) : ENGINES).map((engine) => ({ group, engine }))
);

/** The owner setup every leg starts from; it runs on Chromium even in a WebKit leg. */
const OWNER_SETUP = 'setup';
/** A deployed run's target check (e2e/deployed-setup.ts): HTTP only, so every leg keeps it too. */
export const TARGET_CHECK = 'deployed-setup';

/** The group a (non-setup) project belongs to, by name. */
export function groupOf(name: string): Group {
	if (name.startsWith('sweep-')) return 'sweeps';
	if (name.startsWith('serial-')) return 'serial';
	if (name === 'perf' || name === 'exclusive') return 'alone';
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
 * E2E_GROUP; selectProjects).
 */
export function e2eProjects(env: E2EEnv, local: readonly Project[]): Project[] {
	const mode = e2eMode(env);
	const engine = parseChoice('E2E_ENGINE', env.E2E_ENGINE, ENGINES);
	const group = parseChoice('E2E_GROUP', env.E2E_GROUP, GROUPS);
	const projects = mode === 'local' || mode === 'external-local' ? local : smokeProjects(mode, env);
	return selectProjects(projects, { engine, group });
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
