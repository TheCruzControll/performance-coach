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
import type { Project } from '@playwright/test';

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
		if (name === OWNER_SETUP) return true;
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
