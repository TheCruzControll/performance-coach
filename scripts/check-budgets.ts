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
	`Budgets: initial JS ≤ ${BUDGETS.routeJsKb} KB per route · total CSS ≤ ${BUDGETS.totalCssKb} KB · preloaded fonts ≤ ${BUDGETS.preloadedFonts}`,
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
if (failed.length > 0 || !cssOk || prefixProblems.length > 0 || webauthnProblems.length > 0) {
	const what = [
		...failed.map((r) => r.route),
		...(cssOk ? [] : ['total CSS']),
		...(prefixProblems.length ? ['CSS prefixes'] : []),
		...(webauthnProblems.length ? ['WebAuthn library placement'] : [])
	];
	console.error(`\nbudgets: FAILED (${what.join(', ')})`);
	process.exit(1);
}
console.log('\nbudgets: all within budget');
