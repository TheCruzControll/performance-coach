/**
 * Two build-output guards for the coach, as pure helpers (scripts/check-budgets.ts runs them on
 * the build; client-secret-scan.test.ts proves them on planted input):
 *
 * - Client secrets: no Anthropic SDK code, no credential in a provider format of
 *   scripts/secrets-patterns.ts and not the build-time key reach a file the browser can fetch,
 *   in either build; nor server-only code, which a client file names by the Blob SDK, a
 *   src/lib/server/ path or a server-only variable (scanForServerOnly). The SDK is recognised by literals only its pinned 1.x
 *   release ships (each found in its dist: the test reads node_modules/@anthropic-ai/sdk). Never
 *   a word the app's own copy or pricing table uses: not `x-api-key`, a model id, 'Anthropic' or
 *   'Claude'. When the SDK updates and a literal goes, the positive control fails, and the
 *   signature list is corrected here in one hunk.
 * - Coach isolation: every /workout route (a group-free id matching WORKOUT_ROUTE) can load no
 *   coach module, statically, through an awaited `load` import or on demand, whether as a chunk
 *   of its own or bundled into another chunk (CHUNK_MODULES, written by vite.config.ts, lists
 *   each chunk's source modules). /workout itself must be in the build, so a renamed route
 *   cannot pass by matching nothing.
 */

import { findSecrets, PROVIDER_FORMATS } from './secrets-patterns.ts';

/** Literals only the Anthropic SDK ships: its API version, its host and two of its errors. */
export const SDK_SIGNATURES = [
	'2026-10-21',
	'api.anthropic.com',
	'running in a browser-like environment',
	'Could not resolve authentication method'
] as const;

/** An Anthropic API key in its anchored format (scripts/secrets-patterns.ts). */
export const KEY_PATTERN = new RegExp(
	PROVIDER_FORMATS.find((f) => f.id === 'anthropic')!.pattern.source
);

/**
 * The build-time ANTHROPIC_API_KEY is looked for verbatim when it is at least this long; a
 * shorter value would match ordinary text (CI sets a longer canary in .github/workflows/ci.yml).
 */
export const MIN_SCANNED_KEY_LENGTH = 16;

/** What a text holds that must never reach the browser. Names the finding, never the key. */
export function scanForSecrets(text: string, buildKey?: string): string[] {
	const found = SDK_SIGNATURES.filter((sig) => text.includes(sig)).map(
		(sig) => `Anthropic SDK code ("${sig}")`
	);
	for (const label of new Set(
		findSecrets(text, PROVIDER_FORMATS, { placeholders: false }).map((hit) => hit.format.label)
	)) {
		found.push(label);
	}
	const key = buildKey?.trim() ?? '';
	if (key.length >= MIN_SCANNED_KEY_LENGTH && text.includes(key)) {
		found.push('the build-time ANTHROPIC_API_KEY');
	}
	return found;
}

/** Variables only the server reads: a client file that names one carries server code. */
export const SERVER_ONLY_VARIABLES = [
	'BACKUP_ENCRYPTION_KEY',
	'CRON_SECRET',
	'BLOB_READ_WRITE_TOKEN',
	'DATABASE_URL_UNPOOLED',
	'OWNER_SETUP_TOKEN_HASH',
	'RESEND_API_KEY'
] as const;

/** Literals of server-only code: the Blob SDK, a server module's path, a server variable. */
export const SERVER_ONLY_SIGNATURES = ['@vercel/blob', 'src/lib/server/', ...SERVER_ONLY_VARIABLES];

/**
 * The server-only signatures a client file holds. Build output only: the client source's
 * comments may cite a server path, and minification drops them.
 */
export function scanForServerOnly(text: string): string[] {
	return SERVER_ONLY_SIGNATURES.filter((sig) => text.includes(sig)).map(
		(sig) => `server-only code ("${sig}")`
	);
}

/** Files a client scan skips: compressed twins of files it reads, images and fonts. */
export const UNSCANNED_FILE = /\.(gz|br|woff2?|png|jpe?g|webp|avif|ico)$/;

/**
 * The signatures the server side of the build lacks (the positive control). SvelteKit keeps a
 * dependency external in the server build, so when the server output imports the SDK by name
 * its literals are looked for in `sdkDist`, the installed package that import resolves to.
 */
export function missingSignatures(serverOutput: string, sdkDist: string): string[] {
	const haystack = serverOutput.includes('@anthropic-ai/sdk')
		? `${serverOutput}\n${sdkDist}`
		: serverOutput;
	return SDK_SIGNATURES.filter((sig) => !haystack.includes(sig));
}

/** A route whose id, without its (group) segments, is this matches is a workout route. */
export const WORKOUT_ROUTE = /^\/workout(\/|$)/;
/** A coach module: a source path under a `coach` folder, or a file named coach or coach-…. */
export const COACH_MODULE = /^src\/(?:.+\/)?coach(?:\/|[-.][^/]*$)/;
/** The client build's file mapping each chunk's file to the src/ modules bundled into it. */
export const CHUNK_MODULES = '.vite/chunk-modules.json';
/** The router entry dynamically imports every route's node: not something one route loads. */
const ROUTER_ENTRY = /^_app\/immutable\/entry\//;

/** An entry of Vite's client manifest (.vite/manifest.json); keys are source paths. */
export interface ManifestChunk {
	file: string;
	src?: string;
	imports?: string[];
	dynamicImports?: string[];
}

/** A page route and the manifest keys of its layout and page nodes. */
export interface RouteEntries {
	id: string;
	keys: string[];
}

const withoutGroups = (id: string) => id.replace(/\/\([^/]+\)/g, '') || '/';

/**
 * Every workout route checked, and each chain by which one can load a coach module (static and
 * dynamic imports both, so awaited and on-demand loads count).
 */
export function coachIsolation(
	routes: readonly RouteEntries[],
	chunks: Readonly<Record<string, ManifestChunk>>,
	modules: Readonly<Record<string, readonly string[]>>
): { checked: string[]; problems: string[] } {
	const workout = routes.filter((route) => WORKOUT_ROUTE.test(withoutGroups(route.id)));
	const problems: string[] = [];
	if (!workout.some((route) => withoutGroups(route.id) === '/workout')) {
		problems.push('no /workout route in the build: update this guard');
	}
	if (!Object.values(modules).some((ids) => ids.length)) {
		problems.push(`no source modules in ${CHUNK_MODULES}: update this guard`);
	}
	for (const route of workout) {
		const from = new Map<string, string | null>(route.keys.map((key) => [key, null]));
		const queue = [...route.keys];
		while (queue.length) {
			const key = queue.shift()!;
			const chunk = chunks[key];
			const bundled = chunk && modules[chunk.file]?.find((id) => COACH_MODULE.test(id));
			if (COACH_MODULE.test(key) || bundled) {
				const chain = [bundled && bundled !== key ? `${key} (bundles ${bundled})` : key];
				for (let at = from.get(key); at; at = from.get(at)) chain.unshift(at);
				problems.push(`${route.id}: ${chain.join(' → ')}`);
				continue;
			}
			if (!chunk || ROUTER_ENTRY.test(chunk.file)) continue;
			for (const next of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) {
				if (from.has(next)) continue;
				from.set(next, key);
				queue.push(next);
			}
		}
	}
	return { checked: workout.map((route) => route.id), problems };
}
