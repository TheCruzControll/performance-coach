/**
 * Performance budgets, enforced against the client build output (run after `pnpm build`).
 *
 *   pnpm build && pnpm budgets
 *
 * For every page route it computes what the browser downloads up front — the app entry
 * imports plus the JS of the route's layouts and page (exactly the modulepreload set SvelteKit
 * emits) — and the fonts the server preloads (same policy as hooks.server.ts).
 * Budgets are documented in docs/performance.md.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { PRELOADED_FONT_PATTERN } from '../src/lib/ui/fonts.ts';

export const BUDGETS = {
	/** Initial JS per route (gzip), including the shared shell. */
	routeJsKb: 60,
	/** All CSS in the build (gzip). */
	totalCssKb: 20,
	/** Font files preloaded on any route. */
	preloadedFonts: 2
} as const;

const OUT = '.svelte-kit/output';
const CLIENT = `${OUT}/client`;

interface FontRef {
	file: string;
	filename: string;
}
interface NodeInfo {
	imports: string[];
	stylesheets: string[];
	fonts: FontRef[];
}
interface Route {
	id: string;
	page: { layouts: (number | undefined)[]; leaf: number } | null;
}

if (!existsSync(`${OUT}/server/manifest-full.js`)) {
	console.error('budgets: no build output found. Run `pnpm build` (or `pnpm build:node`) first.');
	process.exit(1);
}

const gzipCache = new Map<string, number>();
function gzipBytes(file: string): number {
	let size = gzipCache.get(file);
	if (size === undefined) {
		size = gzipSync(readFileSync(path.join(CLIENT, file)), { level: 9 }).length;
		gzipCache.set(file, size);
	}
	return size;
}

const kb = (bytes: number) => bytes / 1024;
const fmt = (bytes: number) => `${kb(bytes).toFixed(1)} KB`;

// Read node metadata as data (do not execute app code).
function readNode(index: number): NodeInfo {
	const source = readFileSync(`${OUT}/server/nodes/${index}.js`, 'utf8');
	const grab = <T>(name: string): T => {
		const match = new RegExp(`export const ${name} = (\\[.*?\\]);`).exec(source);
		return (match ? JSON.parse(match[1]!) : []) as T;
	};
	return { imports: grab('imports'), stylesheets: grab('stylesheets'), fonts: grab('fonts') };
}

const { manifest } = (await import(pathToFileURL(`${OUT}/server/manifest-full.js`).href)) as {
	manifest: {
		client: { imports: string[]; stylesheets: string[]; fonts: FontRef[] };
		nodes: unknown[];
		routes: Route[];
	};
};
const { client, routes } = manifest;
const nodes = manifest.nodes.map((_, i) => readNode(i));

interface Row {
	route: string;
	js: number;
	css: number;
	fonts: string[];
	ok: boolean;
}

const rows: Row[] = [];
for (const route of routes) {
	if (!route.page) continue;
	const nodeIds = [...route.page.layouts, route.page.leaf].filter(
		(n): n is number => n !== undefined
	);
	const js = new Set(client.imports);
	const css = new Set(client.stylesheets);
	const fonts = new Set(
		client.fonts.filter((f) => PRELOADED_FONT_PATTERN.test(f.filename)).map((f) => f.file)
	);
	for (const id of nodeIds) {
		const node = nodes[id]!;
		node.imports.forEach((f) => js.add(f));
		node.stylesheets.forEach((f) => css.add(f));
		node.fonts
			.filter((f) => PRELOADED_FONT_PATTERN.test(f.filename))
			.forEach((f) => fonts.add(f.file));
	}
	const jsBytes = [...js].reduce((sum, f) => sum + gzipBytes(f), 0);
	const cssBytes = [...css].reduce((sum, f) => sum + gzipBytes(f), 0);
	rows.push({
		route: route.id,
		js: jsBytes,
		css: cssBytes,
		fonts: [...fonts],
		ok: kb(jsBytes) <= BUDGETS.routeJsKb && fonts.size <= BUDGETS.preloadedFonts
	});
}

const allCss = readdirSync(`${CLIENT}/_app/immutable/assets`).filter((f) => f.endsWith('.css'));
const totalCss = allCss.reduce((sum, f) => sum + gzipBytes(`_app/immutable/assets/${f}`), 0);
const cssOk = kb(totalCss) <= BUDGETS.totalCssKb;
const sw = existsSync(`${CLIENT}/service-worker.js`) ? gzipBytes('service-worker.js') : 0;

const lines = [
	'| Route | Initial JS (gzip) | Route CSS (gzip) | Preloaded fonts | Status |',
	'| --- | ---: | ---: | ---: | :---: |',
	...rows
		.sort((a, b) => b.js - a.js)
		.map(
			(r) =>
				`| \`${r.route}\` | ${fmt(r.js)} | ${fmt(r.css)} | ${r.fonts.length} | ${r.ok ? 'pass' : 'FAIL'} |`
		),
	'',
	`Total CSS (gzip): **${fmt(totalCss)}** across ${allCss.length} files — budget ${BUDGETS.totalCssKb} KB: ${cssOk ? 'pass' : 'FAIL'}`,
	`Service worker (gzip): ${fmt(sw)}`,
	`Budgets: initial JS ≤ ${BUDGETS.routeJsKb} KB per route · total CSS ≤ ${BUDGETS.totalCssKb} KB · preloaded fonts ≤ ${BUDGETS.preloadedFonts}`
];
console.log(lines.join('\n'));

if (process.env.GITHUB_STEP_SUMMARY) {
	appendFileSync(
		process.env.GITHUB_STEP_SUMMARY,
		`## Performance budgets\n\n${lines.join('\n')}\n`
	);
}

const failed = rows.filter((r) => !r.ok);
if (failed.length > 0 || !cssOk) {
	console.error(`\nbudgets: FAILED (${failed.map((r) => r.route).join(', ') || 'total CSS'})`);
	process.exit(1);
}
console.log('\nbudgets: all within budget');
