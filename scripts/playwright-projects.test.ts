/**
 * playwright.config.ts's desktop project (docs/testing.md, Desktop): `desktop-chromium` opens a
 * 1440 × 900 desktop window and selects whole files (every *.desktop.e2e.ts, the shell, offline
 * and axe specs); there is no desktop WebKit project, even where WebKit runs. The
 * iPhone projects stop running *.desktop.e2e.ts and nothing else; the serial projects start after
 * every functional one, and perf and exclusive after those, so perf still runs alone.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listSuite, type Listing } from './journey-map.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

/** The config's projects with WebKit on, as CI loads them. */
async function ciProjects(): Promise<Project[]> {
	vi.resetModules(); // the config reads CI when it loads
	vi.stubEnv('CI', '1');
	for (const name of [
		'E2E_WEBKIT',
		'E2E_SERIAL_ALONE',
		'E2E_PERF_ALONE',
		'E2E_ENGINE',
		'E2E_GROUP'
	]) {
		vi.stubEnv(name, '');
	}
	const { default: config } = await import('../playwright.config.ts');
	return config.projects ?? [];
}

const byName = (projects: Project[], name: string) => {
	const project = projects.find((p) => p.name === name);
	expect(project, `project ${name}`).toBeDefined();
	return project!;
};

/** Every project `name` waits for, directly or through its dependencies. */
function after(projects: Project[], name: string): Set<string> {
	const seen = new Set<string>();
	const visit = (n: string) => {
		for (const dependency of byName(projects, n).dependencies ?? []) {
			if (!seen.has(dependency)) {
				seen.add(dependency);
				visit(dependency);
			}
		}
	};
	visit(name);
	return seen;
}

/** The spec files a project runs, from the real listing. */
function filesOf(listing: Listing, project: string): string[] {
	const files = new Set<string>();
	for (const [key, projects] of listing.tests) {
		if (projects.has(project)) files.add(key.split(' › ')[0]!);
	}
	return [...files].sort();
}

let listed: Listing | undefined;
/** The real listing, read once for the whole file (a listing takes seconds). */
const suite = () => (listed ??= listSuite(root));

/** The titles (`describe › … › test`) of `file`'s tests that `project` runs. */
function titlesOf(listing: Listing, project: string, file: string): string[] {
	const titles: string[] = [];
	for (const [key, projects] of listing.tests) {
		if (projects.has(project) && key.startsWith(`${file} › `)) {
			titles.push(key.slice(file.length + 3));
		}
	}
	return titles.sort();
}

const E2E_FILES = readdirSync(new URL('../e2e/', import.meta.url)).filter((f) =>
	f.endsWith('.e2e.ts')
);
const DESKTOP_FILES = E2E_FILES.filter((f) => f.endsWith('.desktop.e2e.ts'));
const SHARED = ['offline.e2e.ts', 'shell.e2e.ts'];

describe('playwright.config.ts desktop project', () => {
	afterEach(() => vi.unstubAllEnvs());

	it('opens a 1440 × 900 desktop window with the Chromium setup session', async () => {
		const project = byName(await ciProjects(), 'desktop-chromium');
		expect(project.use).toMatchObject({
			browserName: 'chromium',
			viewport: { width: 1440, height: 900 },
			contextOptions: { screen: { width: 1440, height: 900 } },
			deviceScaleFactor: 1,
			isMobile: false,
			hasTouch: false,
			storageState: 'e2e/.auth/chromium.json'
		});
		expect(project.dependencies).toEqual(['setup']);
	});

	it('is the only desktop-size project, even with WebKit on', async () => {
		const desktop = (await ciProjects()).filter(
			(p) => (p.use as { viewport?: { width: number } }).viewport?.width === 1440
		);
		expect(desktop.map((p) => p.name)).toEqual(['desktop-chromium']);
	});

	it('run serial, perf and exclusive specs only after the desktop projects', async () => {
		const projects = await ciProjects();
		const functional = ['iphone-chromium', 'iphone-webkit', 'desktop-chromium'];
		for (const name of ['serial-chromium', 'serial-webkit', 'perf', 'exclusive']) {
			expect([...after(projects, name)], name).toEqual(expect.arrayContaining(functional));
		}
		// perf runs alone: after every project but the sweeps and exclusive, which wait for it.
		const others = projects
			.map((p) => p.name!)
			.filter(
				(n) =>
					!['perf', 'exclusive'].includes(n) && !n.startsWith('setup') && !n.startsWith('sweep-')
			);
		expect([...after(projects, 'perf')]).toEqual(expect.arrayContaining(others));
		for (const sweep of ['sweep-chromium', 'sweep-webkit']) {
			expect([...after(projects, sweep)], sweep).toEqual(
				expect.arrayContaining([...others, 'perf'])
			);
			expect([...after(projects, 'exclusive')], 'exclusive').toContain(sweep);
		}
		expect([...after(projects, 'exclusive')]).toContain('perf');
	});

	it('give a *.sweep.e2e.ts file to the sweep projects only', async () => {
		const projects = await ciProjects();
		const globs = (value: Project['testMatch']) => [value ?? []].flat() as string[];
		const runs = (project: Project, file: string) =>
			globs(project.testMatch ?? '**/*.e2e.ts').some((g) => path.matchesGlob(file, g)) &&
			!globs(project.testIgnore).some((g) => path.matchesGlob(file, g));
		const running = (file: string) => projects.filter((p) => runs(p, file)).map((p) => p.name);
		expect(running('e2e/state-gallery.sweep.e2e.ts')).toEqual(['sweep-chromium', 'sweep-webkit']);
		expect(running('e2e/state-gallery.e2e.ts')).toEqual(
			expect.arrayContaining(['iphone-chromium', 'iphone-webkit'])
		);
	});

	it('give perf.e2e.ts and every perf-*.e2e.ts file to the perf project only', async () => {
		const projects = await ciProjects();
		const globs = (value: Project['testMatch']) => [value ?? []].flat() as string[];
		const runs = (project: Project, file: string) =>
			globs(project.testMatch ?? '**/*.e2e.ts').some((g) => path.matchesGlob(file, g)) &&
			!globs(project.testIgnore).some((g) => path.matchesGlob(file, g));
		for (const file of ['e2e/perf.e2e.ts', 'e2e/perf-workout.e2e.ts']) {
			expect(
				projects.filter((p) => runs(p, file)).map((p) => p.name),
				file
			).toEqual(['perf']);
		}
	});

	it('select whole files: desktop specs move off the iPhone projects, nothing else does', () => {
		const listing = suite();
		expect(DESKTOP_FILES.length, 'desktop specs exist').toBeGreaterThan(0);
		expect(filesOf(listing, 'desktop-chromium')).toEqual(
			[...DESKTOP_FILES, ...SHARED, 'a11y-dark.e2e.ts', 'a11y-light.e2e.ts'].sort()
		);

		// The iPhone projects run every functional spec but the desktop ones.
		const iphone = E2E_FILES.filter(
			(f) =>
				!f.endsWith('.desktop.e2e.ts') &&
				!f.endsWith('.serial.e2e.ts') &&
				!f.endsWith('.exclusive.e2e.ts') &&
				!f.endsWith('.sweep.e2e.ts') &&
				f !== 'perf.e2e.ts' &&
				!f.startsWith('perf-')
		).sort();
		for (const project of ['iphone-chromium', 'iphone-webkit']) {
			expect(filesOf(listing, project), project).toEqual(iphone);
		}
	}, 120_000);

	it('split the axe audit by theme: each half lists the other’s tests, in every browser project', () => {
		const listing = suite();
		const halves = (project: string) => ({
			dark: titlesOf(listing, project, 'a11y-dark.e2e.ts'),
			light: titlesOf(listing, project, 'a11y-light.e2e.ts')
		});
		const expected = halves('iphone-chromium');
		expect(expected.dark.length, 'the dark half has tests').toBeGreaterThan(0);
		for (const theme of ['dark', 'light'] as const) {
			for (const title of expected[theme]) {
				expect(title.startsWith(`accessibility (axe, ${theme} theme) › `), title).toBe(true);
			}
		}
		// Derived, not frozen: a screen or coach state added to the suite lands in both halves.
		const swapped = expected.dark.map((t) => t.replace('(axe, dark theme)', '(axe, light theme)'));
		expect(expected.light).toEqual(swapped.sort());
		for (const project of ['desktop-chromium', 'iphone-webkit']) {
			expect(halves(project), project).toEqual(expected);
		}
	}, 120_000);
});
