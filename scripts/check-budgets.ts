/**
 * Performance budgets, enforced against the client build output (run after `pnpm build`).
 *
 *   pnpm build && pnpm budgets
 *
 * For every page route it computes the JavaScript the browser must load before the page is
 * interactive, the CSS it renders with, and the fonts the server preloads (same policy as
 * hooks.server.ts). Budgets are documented in docs/performance.md.
 *
 * Initial JS is the complete *static* import graph of the app entry and the route's layout and
 * page nodes, read from Vite's manifest — not only the modulepreload list SvelteKit emits, which
 * can miss a chunk that is also reachable through a dynamic import (it is then fetched late, as
 * a waterfall; listed in the report). It also counts what a route's universal `load` imports
 * dynamically (`+page.ts` / `+layout.ts`): the load awaits it before the page hydrates, so it is
 * initial too — the largest such import counts.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { PRELOADED_FONT_PATTERN } from '../src/lib/ui/fonts.ts';

export const BUDGETS = {
	/** Initial JS per route (gzip), including the shared shell. */
	routeJsKb: 60,
	/** CSS a route renders with (gzip): render-blocking, so budgeted per route. */
	routeCssKb: 14,
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
interface ViteChunk {
	file: string;
	src?: string;
	imports?: string[];
	dynamicImports?: string[];
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
function readNode(index: number): NodeInfo & { universal: string | null } {
	const source = readFileSync(`${OUT}/server/nodes/${index}.js`, 'utf8');
	const grab = <T>(name: string): T => {
		const match = new RegExp(`export const ${name} = (\\[.*?\\]);`).exec(source);
		return (match ? JSON.parse(match[1]!) : []) as T;
	};
	const universal = /export const universal_id = ("[^"]*");/.exec(source);
	return {
		imports: grab('imports'),
		stylesheets: grab('stylesheets'),
		fonts: grab('fonts'),
		universal: universal ? (JSON.parse(universal[1]!) as string) : null
	};
}

// Vite's client manifest: the full static import graph (keys are source paths or `_chunk.js`).
const vite = JSON.parse(readFileSync(`${CLIENT}/.vite/manifest.json`, 'utf8')) as Record<
	string,
	ViteChunk
>;
const keyOf = new Map(Object.entries(vite).map(([key, chunk]) => [chunk.file, key]));

/** Every chunk statically imported from `files` (inclusive). */
function staticClosure(files: Iterable<string>): Set<string> {
	const seen = new Set<string>();
	const queue = [...files];
	while (queue.length) {
		const file = queue.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		const key = keyOf.get(file);
		for (const dep of (key && vite[key]?.imports) || []) queue.push(vite[dep]!.file);
	}
	return seen;
}

/**
 * The chunks a universal load imports dynamically (string-literal `import('./…')` in its
 * source, resolved through the manifest). Each is a set of extra files the page waits for.
 */
function loadImports(universalId: string | null): string[] {
	if (!universalId || !existsSync(universalId)) return [];
	const source = readFileSync(universalId, 'utf8');
	const found: string[] = [];
	for (const [, spec] of source.matchAll(/import\(\s*['"`](\.{1,2}\/[^'"`]+)['"`]\s*\)/g)) {
		const key = path.posix.normalize(path.posix.join(path.posix.dirname(universalId), spec!));
		if (vite[key]) found.push(vite[key].file);
	}
	return found;
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
	/** Of `js`: the largest import its universal load awaits before hydrating. */
	loadJs: number;
	css: number;
	fonts: string[];
	/** Statically imported chunks SvelteKit does not modulepreload (fetched as a waterfall). */
	late: string[];
	ok: boolean;
}

const rows: Row[] = [];
for (const route of routes) {
	if (!route.page) continue;
	const nodeIds = [...route.page.layouts, route.page.leaf].filter(
		(n): n is number => n !== undefined
	);
	const preloaded = new Set(client.imports);
	const css = new Set(client.stylesheets);
	const fonts = new Set(
		client.fonts.filter((f) => PRELOADED_FONT_PATTERN.test(f.filename)).map((f) => f.file)
	);
	const universals: (string | null)[] = [];
	for (const id of nodeIds) {
		const node = nodes[id]!;
		node.imports.forEach((f) => preloaded.add(f));
		node.stylesheets.forEach((f) => css.add(f));
		node.fonts
			.filter((f) => PRELOADED_FONT_PATTERN.test(f.filename))
			.forEach((f) => fonts.add(f.file));
		universals.push(node.universal);
	}
	const js = staticClosure(preloaded);
	const sum = (files: Iterable<string>) => [...files].reduce((n, f) => n + gzipBytes(f), 0);
	const loadJs = Math.max(
		0,
		...universals
			.flatMap(loadImports)
			.map((file) => sum([...staticClosure([file])].filter((f) => !js.has(f))))
	);
	const jsBytes = sum(js) + loadJs;
	const cssBytes = sum(css);
	rows.push({
		route: route.id,
		js: jsBytes,
		loadJs,
		css: cssBytes,
		fonts: [...fonts],
		late: [...js].filter((f) => !preloaded.has(f)),
		ok:
			kb(jsBytes) <= BUDGETS.routeJsKb &&
			kb(cssBytes) <= BUDGETS.routeCssKb &&
			fonts.size <= BUDGETS.preloadedFonts
	});
}

const allCss = readdirSync(`${CLIENT}/_app/immutable/assets`).filter((f) => f.endsWith('.css'));
const totalCss = allCss.reduce((sum, f) => sum + gzipBytes(`_app/immutable/assets/${f}`), 0);

/**
 * CSS output guard: every rule that ships a vendor-prefixed property must also ship the
 * standard one. Lightning CSS drops an unprefixed declaration that is followed by its prefixed
 * twin, so `backdrop-filter: …; -webkit-backdrop-filter: …` in source silently ships only the
 * prefixed form and Chromium/Firefox lose the effect. Source declares only the standard
 * property; the minifier adds prefixes for the build targets.
 */
const PREFIXED = ['backdrop-filter', 'mask-image', 'user-select', 'text-size-adjust'];
const prefixProblems: string[] = [];
for (const file of allCss) {
	const css = readFileSync(path.join(CLIENT, '_app/immutable/assets', file), 'utf8');
	for (const [, selector, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
		for (const property of PREFIXED) {
			const prefixed = new RegExp(`(^|;)\\s*-webkit-${property}\\s*:`).test(body!);
			const standard = new RegExp(`(^|;)\\s*${property}\\s*:`).test(body!);
			if (prefixed && !standard) {
				prefixProblems.push(`${file}: \`${selector!.trim()}\` has -webkit-${property} only`);
			}
		}
	}
}
const sw = existsSync(`${CLIENT}/service-worker.js`) ? gzipBytes('service-worker.js') : 0;

/**
 * @simplewebauthn/browser placement: it must never be part of a route's initial JS, and only the
 * sign-in, setup, recovery and Security screens may load it at all (on demand, through
 * src/lib/client/passkeys.ts). Chunks are identified by string literals the library ships, and
 * "may load" follows every static and dynamic import reachable from a route's initial chunks.
 */
const WEBAUTHN_ROUTES = new Set(['/', '/setup', '/recover/passkey', '/(app)/profile/security']);
// String literals only the library ships (our own code mentions its error *codes*, not these).
const WEBAUTHN_SIGNATURES = [
	'Authentication ceremony was sent an abort signal',
	'Registration ceremony was sent an abort signal'
];
const IMPORT_SPECIFIER = /["'`](\.{1,2}\/[^"'`]+?\.js)["'`]/g;
const chunkSource = new Map<string, string>();
const read = (file: string) => {
	let source = chunkSource.get(file);
	if (source === undefined) {
		source = existsSync(path.join(CLIENT, file))
			? readFileSync(path.join(CLIENT, file), 'utf8')
			: '';
		chunkSource.set(file, source);
	}
	return source;
};
const isWebAuthnChunk = (file: string) =>
	WEBAUTHN_SIGNATURES.some((sig) => read(file).includes(sig));
function reachable(entries: Iterable<string>): Set<string> {
	const seen = new Set<string>();
	const queue = [...entries];
	while (queue.length) {
		const file = queue.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		// The app entry lists every route's node for the router: not something this route loads.
		if (file.startsWith('_app/immutable/entry/')) continue;
		for (const [, spec] of read(file).matchAll(IMPORT_SPECIFIER)) {
			queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec!)));
		}
	}
	return seen;
}
const webauthnProblems: string[] = [];
const webauthnRoutes: string[] = [];
for (const route of routes) {
	if (!route.page) continue;
	const initial = new Set(client.imports);
	for (const id of [...route.page.layouts, route.page.leaf]) {
		if (id !== undefined) nodes[id]!.imports.forEach((f) => initial.add(f));
	}
	for (const f of staticClosure(initial)) initial.add(f);
	if ([...initial].some(isWebAuthnChunk)) {
		webauthnProblems.push(`${route.id}: @simplewebauthn/browser is in the initial JS`);
	}
	if ([...reachable(initial)].some(isWebAuthnChunk)) {
		webauthnRoutes.push(route.id);
		if (!WEBAUTHN_ROUTES.has(route.id)) {
			webauthnProblems.push(`${route.id}: can load @simplewebauthn/browser`);
		}
	}
}
for (const id of WEBAUTHN_ROUTES) {
	if (!webauthnRoutes.includes(id))
		webauthnProblems.push(`${id}: cannot load @simplewebauthn/browser`);
}

const lines = [
	'| Route | Initial JS (gzip) | of which awaited by `load` | Route CSS (gzip) | Preloaded fonts | Status |',
	'| --- | ---: | ---: | ---: | ---: | :---: |',
	...rows
		.sort((a, b) => b.js - a.js)
		.map(
			(r) =>
				`| \`${r.route}\` | ${fmt(r.js)} | ${r.loadJs ? fmt(r.loadJs) : '–'} | ${fmt(r.css)} | ${r.fonts.length} | ${r.ok ? 'pass' : 'FAIL'} |`
		),
	'',
	`Total CSS in the build (gzip, not all of it on any one route): ${fmt(totalCss)} across ${allCss.length} files`,
	`Service worker (gzip): ${fmt(sw)}`,
	`Budgets: initial JS ≤ ${BUDGETS.routeJsKb} KB · route CSS ≤ ${BUDGETS.routeCssKb} KB · preloaded fonts ≤ ${BUDGETS.preloadedFonts}`,
	...rows
		.filter((r) => r.late.length)
		.map(
			(r) =>
				`Not modulepreloaded (counted above; fetched after its importer): \`${r.route}\` ${r.late.map((f) => `${path.basename(f)} (${fmt(gzipBytes(f))})`).join(', ')}`
		),
	`CSS output guard (standard property kept next to every -webkit- prefix): ${prefixProblems.length ? 'FAIL' : 'pass'}`,
	`@simplewebauthn/browser: on demand only, never in initial JS; loadable from ${webauthnRoutes
		.sort()
		.map((r) => `\`${r}\``)
		.join(', ')}: ${webauthnProblems.length ? 'FAIL' : 'pass'}`
];
console.log(lines.join('\n'));

if (process.env.GITHUB_STEP_SUMMARY) {
	appendFileSync(
		process.env.GITHUB_STEP_SUMMARY,
		`## Performance budgets\n\n${lines.join('\n')}\n`
	);
}

if (prefixProblems.length > 0) {
	console.error(`\nCSS output guard failed:\n  - ${prefixProblems.join('\n  - ')}`);
}

if (webauthnProblems.length > 0) {
	console.error(`\nWebAuthn library placement failed:\n  - ${webauthnProblems.join('\n  - ')}`);
}

const failed = rows.filter((r) => !r.ok);
if (failed.length > 0 || prefixProblems.length > 0 || webauthnProblems.length > 0) {
	const what = [
		...failed.map((r) => r.route),
		...(prefixProblems.length ? ['CSS prefixes'] : []),
		...(webauthnProblems.length ? ['WebAuthn library placement'] : [])
	];
	console.error(`\nbudgets: FAILED (${what.join(', ')})`);
	process.exit(1);
}
console.log('\nbudgets: all within budget');
