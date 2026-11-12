/**
 * The service worker precaches what offline needs and nothing else (scripts/lib/precache-scope.ts):
 * the shell, the workout pages and /offline with everything they can load, the tabs with the code
 * that renders them, and no other route's code.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
	GRAPHITE_ONLY,
	OFFLINE_PAGES,
	readBuildGraph,
	shellFiles,
	TAB_PAGES,
	type BuildGraph,
	type ScopeRoute,
	type ViteChunk
} from './precache-scope.ts';

/** Node indexes: 0 root layout, 1 root error, 2 app layout, 3 app error, then one leaf per page. */
const SHELL_PAGES = [...OFFLINE_PAGES, ...TAB_PAGES];
const leafOf = (id: string) => 4 + SHELL_PAGES.indexOf(id as (typeof SHELL_PAGES)[number]);
const OTHER_LEAF = 4 + SHELL_PAGES.length;

const route = (id: string, leaf: number): ScopeRoute => ({
	id,
	page: id.startsWith('/(app)/')
		? { layouts: [0, 2], errors: [1, 3], leaf }
		: { layouts: [0], errors: [1, undefined], leaf }
});

const nodeChunk = (i: number): string => `_app/immutable/nodes/${i}.js`;

/**
 * A small build: every node imports a shared chunk; the app entry imports every node lazily; the
 * workout page and a tab each have a lazy sheet; the root layout has a stylesheet with a font;
 * one route (/design) is outside the scope with its own chunk; the run page and Today each load a
 * Graphite-only Status Display, which imports StatusDisplay.
 */
function graph(): BuildGraph {
	const vite: Record<string, ViteChunk> = {
		'entry/start.js': {
			file: '_app/immutable/entry/start.js',
			isEntry: true,
			imports: ['_payload.js']
		},
		'_payload.js': { file: '_app/immutable/chunks/payload.js' },
		'entry/app.js': {
			file: '_app/immutable/entry/app.js',
			isEntry: true,
			imports: ['_framework.js'],
			dynamicImports: Array.from({ length: OTHER_LEAF + 1 }, (_, i) => `nodes/${i}.js`)
		},
		'_framework.js': { file: '_app/immutable/chunks/framework.js' },
		'_shared.js': { file: '_app/immutable/chunks/shared.js' },
		'src/routes/workout/Sheet.svelte': {
			file: '_app/immutable/chunks/workout-sheet.js',
			imports: ['_sheet-dep.js'],
			css: ['_app/immutable/assets/workout-sheet.css']
		},
		'_sheet-dep.js': { file: '_app/immutable/chunks/sheet-dep.js' },
		'src/routes/(app)/train/Plates.svelte': { file: '_app/immutable/chunks/train-plates.js' },
		'src/routes/workout/run/RunStatus.svelte': {
			file: '_app/immutable/chunks/run-status.js',
			imports: ['_status-display.js']
		},
		'src/routes/(app)/today/panels/TodayStatus.svelte': {
			file: '_app/immutable/chunks/today-status.js',
			imports: ['_status-display.js']
		},
		'_status-display.js': { file: '_app/immutable/chunks/status-display.js' },
		'_design-only.js': { file: '_app/immutable/chunks/design-only.js' },
		'src/routes/+layout.css': {
			file: '_app/immutable/assets/0.css',
			assets: ['_app/immutable/assets/mona.woff2']
		}
	};
	for (let i = 0; i <= OTHER_LEAF; i++) {
		vite[`nodes/${i}.js`] = { file: nodeChunk(i), isEntry: true, imports: ['_shared.js'] };
	}
	vite[`nodes/${leafOf('/workout')}.js`]!.dynamicImports = ['src/routes/workout/Sheet.svelte'];
	vite[`nodes/${leafOf('/(app)/train')}.js`]!.dynamicImports = [
		'src/routes/(app)/train/Plates.svelte'
	];
	vite[`nodes/${leafOf('/workout/run')}.js`]!.dynamicImports = [
		'src/routes/workout/run/RunStatus.svelte'
	];
	vite[`nodes/${leafOf('/(app)/today')}.js`]!.dynamicImports = [
		'src/routes/(app)/today/panels/TodayStatus.svelte'
	];
	vite[`nodes/${OTHER_LEAF}.js`]!.imports = ['_shared.js', '_design-only.js'];
	vite['nodes/0.js']!.css = ['_app/immutable/assets/0.css'];

	return {
		vite,
		entry: ['_app/immutable/entry/start.js', '_app/immutable/entry/app.js'],
		routes: [
			...SHELL_PAGES.map((id) => route(id, leafOf(id))),
			route('/design', OTHER_LEAF),
			{ id: '/api/health', page: null }
		],
		nodeFiles: (i) => [nodeChunk(i), ...(i === 0 ? ['_app/immutable/assets/0.css'] : [])]
	};
}

describe('shellFiles', () => {
	const files = shellFiles(graph());

	it("holds SvelteKit's entry with what it imports, and the shell's layouts and error pages", () => {
		expect(files).toEqual(
			expect.arrayContaining([
				'_app/immutable/entry/start.js',
				'_app/immutable/chunks/payload.js',
				'_app/immutable/entry/app.js',
				'_app/immutable/chunks/framework.js',
				'_app/immutable/chunks/shared.js',
				...[0, 1, 2, 3].map(nodeChunk)
			])
		);
	});

	it('holds every page served offline and every tab', () => {
		expect(files).toEqual(expect.arrayContaining(SHELL_PAGES.map((id) => nodeChunk(leafOf(id)))));
	});

	it('holds what a workout page loads on demand (a sheet, its imports and its styles)', () => {
		expect(files).toEqual(
			expect.arrayContaining([
				'_app/immutable/chunks/workout-sheet.js',
				'_app/immutable/chunks/sheet-dep.js',
				'_app/immutable/assets/workout-sheet.css'
			])
		);
	});

	it('holds the stylesheets and the fonts they use', () => {
		expect(files).toEqual(
			expect.arrayContaining(['_app/immutable/assets/0.css', '_app/immutable/assets/mona.woff2'])
		);
	});

	it("leaves out a tab's on-demand code and every other route's", () => {
		expect(files).not.toContain('_app/immutable/chunks/train-plates.js');
		expect(files).not.toContain(nodeChunk(OTHER_LEAF));
		expect(files).not.toContain('_app/immutable/chunks/design-only.js');
	});

	it("leaves out Graphite 2004's Status Displays, even on a page served offline", () => {
		expect(files).not.toContain('_app/immutable/chunks/run-status.js');
		expect(files).not.toContain('_app/immutable/chunks/today-status.js');
		expect(files).not.toContain('_app/immutable/chunks/status-display.js');
	});

	it('fails when the build lacks a Status Display it must leave out', () => {
		const build = graph();
		delete build.vite[GRAPHITE_ONLY[1]];
		expect(() => shellFiles(build)).toThrow(`precache: the build has no ${GRAPHITE_ONLY[1]}`);
	});

	it('lists each file once, sorted', () => {
		expect(files).toEqual([...new Set(files)].sort());
		// 4 entry files, the shared chunk, 4 shell nodes, 9 pages, the sheet with 2 more, a stylesheet and its font.
		expect(files).toHaveLength(23);
	});

	it('fails when the build lacks a page it must keep offline', () => {
		const build = graph();
		build.routes = build.routes.filter((r) => r.id !== '/workout/run');
		expect(() => shellFiles(build)).toThrow('precache: the build has no page /workout/run');
	});
});

/** `src/routes/(app)/offline/+page.ts` → `/(app)/offline`. */
const routeId = (file: string) =>
	`/${path.posix.dirname(path.relative('src/routes', file).split(path.sep).join('/'))}`.replace(
		/\/\.$/,
		''
	);

describe('OFFLINE_PAGES', () => {
	it('is every prerendered page: the pages the service worker serves from the precache', () => {
		const prerendered = readdirSync('src/routes', { recursive: true, encoding: 'utf8' })
			// A page can be prerendered from its +page, +page.server or an enclosing +layout: a layout's
			// directory listed here fails the comparison, as it should.
			.filter((file) => /(^|[\\/])\+(page|layout)(\.server)?\.ts$/.test(file))
			.map((file) => path.join('src/routes', file))
			.filter((file) => /export const prerender = true;/.test(readFileSync(file, 'utf8')))
			.map(routeId);
		expect(prerendered.sort()).toEqual([...OFFLINE_PAGES].sort());
	});
});

describe('readBuildGraph', () => {
	it('fails when a server node has no imports export, rather than precaching none of its files', async () => {
		const out = mkdtempSync(path.join(tmpdir(), 'precache-scope-'));
		onTestFinished(() => rmSync(out, { recursive: true }));
		mkdirSync(path.join(out, 'client/.vite'), { recursive: true });
		mkdirSync(path.join(out, 'server/nodes'), { recursive: true });
		writeFileSync(path.join(out, 'client/.vite/manifest.json'), '{}');
		writeFileSync(
			path.join(out, 'server/manifest-full.js'),
			'export const manifest = { client: { imports: [], stylesheets: [] }, routes: [] };'
		);
		writeFileSync(
			path.join(out, 'server/nodes/0.js'),
			'export const stylesheets = [];\nexport const fonts = [];\n'
		);
		const build = await readBuildGraph(out);
		expect(() => build.nodeFiles(0)).toThrow('precache: server/nodes/0.js has no imports export');
	});
});
