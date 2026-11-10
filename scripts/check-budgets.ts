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
import { CATALOGUE_HEADER } from '../src/lib/domain/exercises/format.ts';
import {
	CHUNK_MODULES,
	coachIsolation,
	missingSignatures,
	scanForSecrets,
	scanForServerOnly,
	UNSCANNED_FILE
} from './client-secret-scan.ts';
import { PRELOADED_FONT_PATTERN } from '../src/lib/ui/fonts.ts';
import { icons } from '../src/lib/ui/icons/icons.ts';

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
	/** The stylesheets SvelteKit inlines into the page instead of linking them. */
	inlineStyles: string[];
	/** The node's component, e.g. `(app)/_layout` (null for a node without one). */
	component: string | null;
}
interface Route {
	id: string;
	page: { layouts: (number | undefined)[]; leaf: number } | null;
}
interface ViteChunk {
	file: string;
	/** The chunk's name: for a chunk group's chunk, the group's name. */
	name?: string;
	src?: string;
	imports?: string[];
	dynamicImports?: string[];
	css?: string[];
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
	const inline = /export const inline_styles = \(\) => \(\{([\s\S]*?)\}\);/.exec(source);
	const component = /import\('\.\.\/entries\/pages\/(.+?)\.svelte\.js'\)/.exec(source);
	return {
		imports: grab('imports'),
		stylesheets: grab('stylesheets'),
		fonts: grab('fonts'),
		inlineStyles: [...(inline?.[1] ?? '').matchAll(/"([^"]+)":/g)].map((m) => m[1]!),
		component: component?.[1] ?? null,
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
const PREFIXED = ['backdrop-filter', 'mask', 'mask-image', 'user-select', 'text-size-adjust'];
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
 * App shell inlining: the (app) layout's own stylesheets (AppShell with the nav, and the icons)
 * are inlined into every app page while each is shorter than SvelteKit's inlineStyleThreshold
 * (vite.config.ts). One that grows past it becomes a render-blocking request on every app route,
 * phone included, and no gzip budget notices. The server node lists what it inlined
 * (`inline_styles`); page-agnostic shell rules belong in src/lib/ui/styles/layout.css instead.
 */
const INLINE_STYLE_THRESHOLD = Number(
	/inlineStyleThreshold:\s*(\d+)/.exec(readFileSync('vite.config.ts', 'utf8'))?.[1]
);
const SHELL_LAYOUT = '(app)/_layout';
const shellNode = nodes.find((node) => node.component === SHELL_LAYOUT);
const lengthOf = (file: string) => readFileSync(path.join(CLIENT, file), 'utf8').length;
const count = (n: number) => n.toLocaleString('en');
const shellProblems: string[] = [];
if (!Number.isFinite(INLINE_STYLE_THRESHOLD)) {
	shellProblems.push('no inlineStyleThreshold in vite.config.ts: update this guard');
}
if (!shellNode) shellProblems.push(`no ${SHELL_LAYOUT} node in the build: update this guard`);
for (const file of shellNode?.stylesheets ?? []) {
	if (!shellNode!.inlineStyles.includes(file)) {
		shellProblems.push(
			`${path.basename(file)} is ${count(lengthOf(file))} characters, not under ${count(INLINE_STYLE_THRESHOLD)}, ` +
				'so it is linked instead of inlined: move page-agnostic rules to src/lib/ui/styles/layout.css'
		);
	}
}
const shellSheet = shellNode?.stylesheets.find((file) =>
	path.basename(file).startsWith('AppShell.')
);
if (shellNode && !shellSheet) shellProblems.push(`no AppShell stylesheet in ${SHELL_LAYOUT}`);

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

/**
 * Validation placement: zod and the training-profile schemas (src/lib/domain/profile/schemas.ts)
 * load on demand (src/lib/client/profile-form.ts) and are never part of a route's initial JS,
 * including what its universal `load` awaits. Chunks are identified by string literals: zod's
 * base type name, and messages only the schemas file contains (keep them out of UI copy). When
 * the build has a chunk for the schemas, each literal must still be found in it or its imports.
 */
const VALIDATION_SIGNATURES = [
	'$ZodType',
	'Pick an event or a general goal',
	'Clear your lifts, or untick'
];
const isValidationChunk = (file: string) =>
	VALIDATION_SIGNATURES.some((sig) => read(file).includes(sig));
const validationProblems: string[] = [];
for (const route of routes) {
	if (!route.page) continue;
	const ids = [...route.page.layouts, route.page.leaf].filter((n): n is number => n !== undefined);
	const initial = staticClosure([
		...client.imports,
		...ids.flatMap((id) => nodes[id]!.imports),
		...ids.flatMap((id) => loadImports(nodes[id]!.universal))
	]);
	if ([...initial].some(isValidationChunk)) {
		validationProblems.push(`${route.id}: zod or the profile schemas are in the initial JS`);
	}
}
const schemasChunk = vite['src/lib/domain/profile/schemas.ts']?.file;
if (schemasChunk) {
	const shipped = [...staticClosure([schemasChunk])].map(read).join('\n');
	for (const sig of VALIDATION_SIGNATURES.filter((s) => !shipped.includes(s))) {
		validationProblems.push(`"${sig}" is not in the schemas chunk: update VALIDATION_SIGNATURES`);
	}
}

/**
 * Profile sections: a section page renders with the CSS of what it imports up front (the screen,
 * its skeleton and Save bar), never with an editor's, its own or another section's. Each editor
 * loads on demand from the registry and its styles arrive with it, before it mounts, so adding a
 * section costs no section page anything. SvelteKit links into a page the CSS of every dynamic
 * import its server build can reach (`eager_css` in @sveltejs/kit's build_server.js), so the
 * server build leaves the registry out (SectionScreen.svelte). The editors are the registry's
 * `import('./….svelte')` specifiers; a section page is any route whose page can load one.
 */
const EDITOR_REGISTRY = 'src/lib/ui/profile/editors.ts';
const EDITOR_IMPORT = /import\(\s*['"`](\.\/[^'"`]+\.svelte)['"`]\s*\)/g;
const editorKeys = [...readFileSync(EDITOR_REGISTRY, 'utf8').matchAll(EDITOR_IMPORT)].map(
	([, spec]) => path.posix.join(path.posix.dirname(EDITOR_REGISTRY), spec!)
);
/** Manifest keys reachable from `keys` through static and dynamic imports (inclusive). */
function loadable(keys: Iterable<string>): Set<string> {
	const seen = new Set<string>();
	const queue = [...keys];
	while (queue.length) {
		const key = queue.pop()!;
		if (seen.has(key)) continue;
		seen.add(key);
		queue.push(...(vite[key]?.imports ?? []), ...(vite[key]?.dynamicImports ?? []));
	}
	return seen;
}
const keysOf = (files: Iterable<string>) =>
	[...files].map((file) => keyOf.get(file)).filter((key): key is string => key !== undefined);
const cssOf = (keys: Iterable<string>) => new Set([...keys].flatMap((key) => vite[key]?.css ?? []));
const sectionProblems: string[] = editorKeys.length
	? editorKeys.filter((key) => !vite[key]).map((key) => `${key} is not in the build`)
	: [`no editor found in ${EDITOR_REGISTRY}: update this guard`];
const editorCss = cssOf(loadable(editorKeys));
const sectionRoutes: string[] = [];
/** The stylesheets only an editor brings to some section page: none of them may be linked. */
const keptOut = new Set<string>();
for (const route of routes) {
	if (!route.page) continue;
	const ids = [...route.page.layouts, route.page.leaf].filter((n): n is number => n !== undefined);
	const canLoad = loadable(keysOf(nodes[route.page.leaf]!.imports));
	if (!editorKeys.some((key) => canLoad.has(key))) continue;
	sectionRoutes.push(route.id);
	const upFront = cssOf(
		keysOf(staticClosure([...client.imports, ...ids.flatMap((id) => nodes[id]!.imports)]))
	);
	const linked = new Set([...client.stylesheets, ...ids.flatMap((id) => nodes[id]!.stylesheets)]);
	for (const file of [...editorCss].filter((f) => !upFront.has(f))) {
		keptOut.add(file);
		if (linked.has(file)) {
			sectionProblems.push(`${route.id}: links an editor's ${path.basename(file)}`);
		}
	}
}
if (!sectionRoutes.length) sectionProblems.push('no route can load a section editor');

/**
 * Server-only packages: the exercise catalogue (src/lib/domain/exercises) is in no client file at
 * all, initial or loaded later, the service worker included. Every catalogue table starts with
 * CATALOGUE_HEADER, the literal format.ts reserves as its bundle signature. This is the second
 * line of defence behind the server-only lint rule (eslint.config.js), and it also sees dynamic
 * imports, which the rule does not.
 */
const catalogueChunks = readdirSync(CLIENT, { recursive: true, encoding: 'utf8' })
	.map((file) => file.split(path.sep).join('/'))
	.filter((file) => file.endsWith('.js') && read(file).includes(CATALOGUE_HEADER));

/**
 * Icon placement: every icon draws from the SVG sprite (src/lib/ui/icons/sprite.svg, through
 * <use>), so no client chunk may contain icon path data, and the sprite must ship as its own
 * file (a data: URL would put it back in JS, and Chrome does not draw data: URLs in <use>). Each
 * path in icons.ts is looked for as a quoted string, as a module or template would carry it.
 */
const iconsDrawing = new Map<string, string[]>();
for (const [name, paths] of Object.entries(icons)) {
	for (const d of paths.map((p) => p.replace(/^fill:/, ''))) {
		iconsDrawing.set(d, [...(iconsDrawing.get(d) ?? []), name]);
	}
}
// A quote, the path (optionally `fill:`-prefixed), then a quote (escaped inside a string).
const ICON_PATH_LITERAL = new RegExp(
	String.raw`["'${'`'}](?:fill:)?(${[...iconsDrawing.keys()]
		.sort((a, b) => b.length - a.length)
		.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		.join('|')})\\?["'${'`'}]`,
	'g'
);
const iconProblems: string[] = [];
const clientJs = readdirSync(`${CLIENT}/_app/immutable`, { recursive: true, encoding: 'utf8' })
	.filter((f) => f.endsWith('.js'))
	.map((f) => `_app/immutable/${f}`);
for (const file of clientJs) {
	const names = new Set(
		[...read(file).matchAll(ICON_PATH_LITERAL)].flatMap((m) => iconsDrawing.get(m[1]!) ?? [])
	);
	if (names.size) iconProblems.push(`${file}: path data of ${[...names].join(', ')}`);
}
if (!readdirSync(`${CLIENT}/_app/immutable/assets`).some((f) => /^sprite\.[\w-]+\.svg$/.test(f))) {
	iconProblems.push('the icon sprite is not a file in the build (inlined as a data: URL?)');
}

/**
 * Client secrets: no Anthropic SDK code, provider-format credential (scripts/secrets-patterns.ts),
 * build-time ANTHROPIC_API_KEY (CI builds with a canary) or server-only code (the Blob SDK, a
 * src/lib/server/ path, a server-only variable name), each reported per file, in any file of
 * either build the browser can fetch: `pnpm build` leaves the
 * Vercel output and `pnpm build:node` the Node one, and .svelte-kit/output holds the last.
 * Positive control: once the coach's composition root (agent/coach.ts) loads the provider, the
 * server build carries every signature, so a signature the SDK no longer ships fails here instead
 * of letting the scan go blind. Before then no route reaches the provider, and SvelteKit leaves an
 * unreachable module out of the server build.
 */
const CLIENT_OUTPUTS = [
	CLIENT,
	`${OUT}/prerendered`,
	'build/client',
	'build/prerendered',
	'.vercel/output/static'
].filter((dir) => existsSync(dir));
const BUILD_KEY = process.env.ANTHROPIC_API_KEY;
const filesIn = (dir: string) =>
	readdirSync(dir, { recursive: true, encoding: 'utf8', withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => path.join(entry.parentPath, entry.name));
const secretProblems: string[] = [];
if (process.env.GITHUB_ACTIONS === 'true' && !BUILD_KEY) {
	secretProblems.push('ANTHROPIC_API_KEY (the CI canary) is not set for the build and budgets');
}
let scannedFiles = 0;
for (const file of CLIENT_OUTPUTS.flatMap(filesIn).filter((f) => !UNSCANNED_FILE.test(f))) {
	scannedFiles++;
	const text = readFileSync(file, 'utf8');
	for (const what of [...scanForSecrets(text, BUILD_KEY), ...scanForServerOnly(text)]) {
		secretProblems.push(`${file}: ${what}`);
	}
}
const PROVIDER_ROOT = 'src/lib/server/agent/coach.ts';
const SDK_DIST = 'node_modules/@anthropic-ai/sdk';
let control = 'not reachable yet';
if (existsSync(PROVIDER_ROOT)) {
	const text = (dir: string, keep: RegExp) =>
		existsSync(dir)
			? filesIn(dir)
					.filter((f) => keep.test(f))
					.map((f) => readFileSync(f, 'utf8'))
					.join('\n')
			: '';
	const missing = missingSignatures(text(`${OUT}/server`, /\.js$/), text(SDK_DIST, /\.mjs$/));
	control = missing.length ? 'FAIL' : 'pass';
	for (const sig of missing) {
		secretProblems.push(`"${sig}" is not in the server build: update SDK_SIGNATURES`);
	}
}

/** Coach isolation: no /workout route can load a coach module (scripts/client-secret-scan.ts). */
const isolation = coachIsolation(
	routes
		.filter((route) => route.page)
		.map((route) => ({
			id: route.id,
			keys: keysOf(
				[...route.page!.layouts, route.page!.leaf]
					.filter((n): n is number => n !== undefined)
					.flatMap((id) => nodes[id]!.imports)
			)
		})),
	vite,
	JSON.parse(readFileSync(`${CLIENT}/${CHUNK_MODULES}`, 'utf8')) as Record<string, string[]>
);

/**
 * The root error page on every start-up: SvelteKit imports it before it hydrates any page, so
 * whatever it imports statically is a step on every route's start-up, however rarely an error
 * shows. Apart from its own small chunk it may bring no script or stylesheet a route does not
 * already load: its content loads on demand (src/routes/error-page.ts).
 */
const ROOT_ERROR = '_error';
const rootError = nodes.find((node) => node.component === ROOT_ERROR);
const rootErrorProblems: string[] = [];
const rootErrorFile = rootError?.imports[0];
if (!rootError || !rootErrorFile) {
	rootErrorProblems.push(`no ${ROOT_ERROR} node in the build: update this guard`);
} else {
	const errorJs = staticClosure(rootError.imports);
	const errorCss = cssOf(keysOf(errorJs));
	for (const route of routes) {
		if (!route.page) continue;
		const ids = [...route.page.layouts, route.page.leaf].filter(
			(n): n is number => n !== undefined
		);
		const js = staticClosure([...client.imports, ...ids.flatMap((id) => nodes[id]!.imports)]);
		const css = cssOf(keysOf(js));
		const extra = [
			...[...errorJs].filter((f) => f !== rootErrorFile && !js.has(f)),
			...[...errorCss].filter((f) => !css.has(f))
		];
		if (extra.length) {
			rootErrorProblems.push(`${route.id}: ${extra.map((f) => path.basename(f)).join(', ')}`);
		}
	}
}

/**
 * start.js imports SvelteKit's payload module and the preload helper alone (the `payload` chunk
 * group in vite.config.ts): it runs its imports before it sets the payload, then imports the
 * client, whose modules read the payload while they initialise ($app/env's version). A chunk
 * group that pulled the payload module in with them would run them early, with an empty payload.
 */
const PAYLOAD_GROUP = 'payload';
const startEntry = Object.entries(vite).find(([key]) =>
	key.endsWith('/@sveltejs/kit/src/runtime/client/entry.js')
)?.[1];
const startImports = startEntry?.imports ?? [];
const payloadProblem = !startEntry
	? 'no SvelteKit start entry in the build: update this guard'
	: startImports.length !== 1 ||
		  vite[startImports[0]!]?.name !== PAYLOAD_GROUP ||
		  vite[startImports[0]!]?.imports?.length
		? `${path.basename(startEntry.file)} imports ${startImports.map((k) => `${path.basename(vite[k]!.file)} (${vite[k]!.name})`).join(', ')}`
		: '';

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
	`Root error page (imported before every hydration): its own ${rootErrorFile ? fmt(gzipBytes(rootErrorFile)) : '?'} chunk, no script or stylesheet a route does not load: ${rootErrorProblems.length ? 'FAIL' : 'pass'}`,
	`SvelteKit start entry imports only the payload chunk (it runs it before setting the payload): ${payloadProblem ? 'FAIL' : 'pass'}`,
	`App shell stylesheets inlined into every app page (AppShell ${shellSheet ? count(lengthOf(shellSheet)) : '?'} of ${count(INLINE_STYLE_THRESHOLD)} characters): ${shellProblems.length ? 'FAIL' : 'pass'}`,
	`@simplewebauthn/browser: on demand only, never in initial JS; loadable from ${webauthnRoutes
		.sort()
		.map((r) => `\`${r}\``)
		.join(', ')}: ${webauthnProblems.length ? 'FAIL' : 'pass'}`,
	`Validation (zod, profile schemas): on demand only, never in initial JS: ${validationProblems.length ? 'FAIL' : 'pass'}`,
	`Profile sections: no editor's CSS on a section page (${sectionRoutes.map((r) => `\`${r}\``).join(', ')}; ${editorKeys.length} editors, ${keptOut.size} of their stylesheets left to load with them): ${sectionProblems.length ? 'FAIL' : 'pass'}`,
	`Exercise catalogue (server-only): in no client chunk: ${catalogueChunks.length ? 'FAIL' : 'pass'}`,
	`Icon paths in JS (every icon draws from the SVG sprite): ${iconProblems.length ? 'FAIL' : 'pass'}`,
	`Client secrets (Anthropic SDK, provider-format keys, the build-time key, server-only code) in ${scannedFiles} files of ${CLIENT_OUTPUTS.map((d) => `\`${d}\``).join(', ')}: ${secretProblems.length ? 'FAIL' : 'pass'}; positive control (every SDK signature in the server build): ${control}`,
	`Coach isolation (no coach module loadable from ${isolation.checked.map((r) => `\`${r}\``).join(', ')}): ${isolation.problems.length ? 'FAIL' : 'pass'}`
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

if (shellProblems.length > 0) {
	console.error(`\nApp shell inlining failed:\n  - ${shellProblems.join('\n  - ')}`);
}

if (rootErrorProblems.length > 0) {
	console.error(
		`\nRoot error page start-up failed (it imports what these routes do not load):\n  - ${rootErrorProblems.join('\n  - ')}`
	);
}

if (payloadProblem) {
	console.error(`\nSvelteKit start entry failed: ${payloadProblem}`);
}

if (webauthnProblems.length > 0) {
	console.error(`\nWebAuthn library placement failed:\n  - ${webauthnProblems.join('\n  - ')}`);
}

if (validationProblems.length > 0) {
	console.error(`\nValidation placement failed:\n  - ${validationProblems.join('\n  - ')}`);
}

if (sectionProblems.length > 0) {
	console.error(`\nProfile section CSS failed:\n  - ${sectionProblems.join('\n  - ')}`);
}

if (catalogueChunks.length > 0) {
	console.error(
		`\nThe exercise catalogue reached the browser (its header is in):\n  - ${catalogueChunks.join('\n  - ')}`
	);
}

if (iconProblems.length > 0) {
	console.error(`\nIcon placement failed:\n  - ${iconProblems.join('\n  - ')}`);
}

if (secretProblems.length > 0) {
	console.error(`\nClient secrets failed:\n  - ${secretProblems.join('\n  - ')}`);
}

if (isolation.problems.length > 0) {
	console.error(`\nCoach isolation failed:\n  - ${isolation.problems.join('\n  - ')}`);
}

const failed = rows.filter((r) => !r.ok);
if (
	failed.length > 0 ||
	prefixProblems.length > 0 ||
	shellProblems.length > 0 ||
	rootErrorProblems.length > 0 ||
	payloadProblem ||
	webauthnProblems.length > 0 ||
	validationProblems.length > 0 ||
	sectionProblems.length > 0 ||
	catalogueChunks.length > 0 ||
	iconProblems.length > 0 ||
	secretProblems.length > 0 ||
	isolation.problems.length > 0
) {
	const what = [
		...failed.map((r) => r.route),
		...(prefixProblems.length ? ['CSS prefixes'] : []),
		...(shellProblems.length ? ['app shell inlining'] : []),
		...(rootErrorProblems.length ? ['root error page'] : []),
		...(payloadProblem ? ['SvelteKit start entry'] : []),
		...(webauthnProblems.length ? ['WebAuthn library placement'] : []),
		...(validationProblems.length ? ['validation placement'] : []),
		...(sectionProblems.length ? ['profile section CSS'] : []),
		...(catalogueChunks.length ? ['catalogue placement'] : []),
		...(iconProblems.length ? ['icon paths in JS'] : []),
		...(secretProblems.length ? ['client secrets'] : []),
		...(isolation.problems.length ? ['coach isolation'] : [])
	];
	console.error(`\nbudgets: FAILED (${what.join(', ')})`);
	process.exit(1);
}
console.log('\nbudgets: all within budget');
