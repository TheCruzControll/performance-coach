/**
 * playwright.config.ts's desktop projects (docs/testing.md, Desktop): `desktop-chromium` and,
 * wherever WebKit runs, `desktop-webkit` open a 1440 × 900 desktop window and select whole files
 * (every *.desktop.e2e.ts, the shell and offline specs, and the axe audit on Chromium only). The
 * iPhone projects stop running *.desktop.e2e.ts and nothing else; the serial projects start after
 * every functional one, and perf and exclusive after those, so perf still runs alone.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Project } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listSuite, type Listing } from './journey-map.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

/** The config's projects with WebKit on, as CI loads them. */
async function ciProjects(): Promise<Project[]> {
	vi.resetModules(); // the config reads CI when it loads
	vi.stubEnv('CI', '1');
	for (const name of ['E2E_WEBKIT', 'E2E_SERIAL_ALONE', 'E2E_PERF_ALONE']) vi.stubEnv(name, '');
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

const E2E_FILES = readdirSync(new URL('../e2e/', import.meta.url)).filter((f) =>
	f.endsWith('.e2e.ts')
);
const DESKTOP_FILES = E2E_FILES.filter((f) => f.endsWith('.desktop.e2e.ts'));
const SHARED = ['offline.e2e.ts', 'shell.e2e.ts'];

describe('playwright.config.ts desktop projects', () => {
	afterEach(() => vi.unstubAllEnvs());

	it('open a 1440 × 900 desktop window with the setup sessions, on both engines', async () => {
		const projects = await ciProjects();
		for (const [name, browserName, setup, state] of [
			['desktop-chromium', 'chromium', 'setup', 'e2e/.auth/chromium.json'],
			['desktop-webkit', 'webkit', 'setup-webkit', 'e2e/.auth/webkit.json']
		] as const) {
			const project = byName(projects, name);
			expect(project.use, name).toMatchObject({
				browserName,
				viewport: { width: 1440, height: 900 },
				contextOptions: { screen: { width: 1440, height: 900 } },
				deviceScaleFactor: 1,
				isMobile: false,
				hasTouch: false,
				storageState: state
			});
			expect(project.dependencies, name).toEqual([setup]);
		}
	});

	it('leave out WebKit where it does not run', async () => {
		vi.resetModules();
		vi.stubEnv('CI', '');
		vi.stubEnv('E2E_WEBKIT', '');
		const { default: config } = await import('../playwright.config.ts');
		const names = (config.projects ?? []).map((p) => p.name);
		expect(names).toContain('desktop-chromium');
		expect(names).not.toContain('desktop-webkit');
	});

	it('run serial, perf and exclusive specs only after the desktop projects', async () => {
		const projects = await ciProjects();
		const functional = ['iphone-chromium', 'iphone-webkit', 'desktop-chromium', 'desktop-webkit'];
		for (const name of ['serial-chromium', 'serial-webkit', 'perf', 'exclusive']) {
			expect([...after(projects, name)], name).toEqual(expect.arrayContaining(functional));
		}
		// perf runs alone: after every project but exclusive, which waits for perf in turn.
		const others = projects
			.map((p) => p.name!)
			.filter((n) => !['perf', 'exclusive'].includes(n) && !n.startsWith('setup'));
		expect([...after(projects, 'perf')]).toEqual(expect.arrayContaining(others));
		expect([...after(projects, 'exclusive')]).toContain('perf');
	});

	it('select whole files: desktop specs move off the iPhone projects, nothing else does', () => {
		const listing = listSuite(root);
		expect(DESKTOP_FILES.length, 'desktop specs exist').toBeGreaterThan(0);
		expect(filesOf(listing, 'desktop-chromium')).toEqual(
			[...DESKTOP_FILES, ...SHARED, 'a11y.e2e.ts'].sort()
		);
		expect(filesOf(listing, 'desktop-webkit')).toEqual([...DESKTOP_FILES, ...SHARED].sort());

		// The iPhone projects run every functional spec but the desktop ones.
		const iphone = E2E_FILES.filter(
			(f) =>
				!f.endsWith('.desktop.e2e.ts') &&
				!f.endsWith('.serial.e2e.ts') &&
				!f.endsWith('.exclusive.e2e.ts') &&
				f !== 'perf.e2e.ts'
		).sort();
		for (const project of ['iphone-chromium', 'iphone-webkit']) {
			expect(filesOf(listing, project), project).toEqual(iphone);
		}
	}, 120_000);
});
