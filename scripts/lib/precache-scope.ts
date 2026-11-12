/**
 * The build files the service worker precaches (src/service-worker/index.ts): what the app shell,
 * the workout pages and /offline need to work with no network, and nothing else. vite.config.ts
 * computes the list once the client build is written and hands it to the worker; the rest of
 * `_app/immutable` is cached on first use instead (cache-first, hashed so never stale).
 *
 * - The pages the worker serves from the precache (the prerendered /offline and workout pages) get
 *   everything they can load, lazy code included: an offline launch mid-workout opens the logger,
 *   its sheets and the plate calculator with no network, as does /offline's Start.
 * - The five tabs keep the shell offline (a data screen shows the designed offline state in it):
 *   they get the code that renders them, not what they load on demand.
 * - The shell itself (SvelteKit's entry, the root and app layouts and error pages) gets everything.
 *
 * - Graphite 2004's Status Displays and week legend (GRAPHITE_ONLY) are left out: a device on today's design never
 *   loads them, so its worker must not fetch them either; offline, StatusSlot then shows none.
 *
 * A route id or Status Display here that the build does not have fails the build, so renaming one
 * cannot quietly drop a page from offline support or put Graphite code in every device's precache.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Pages served from the precache, with all they can load (scripts/precache-scope.test.ts: the prerendered pages). */
export const OFFLINE_PAGES = [
	'/(app)/offline',
	'/workout',
	'/workout/run',
	'/workout/session'
] as const;

/** The tabs (AppNav): the code that renders each, without its lazy imports. */
export const TAB_PAGES = [
	'/(app)/today',
	'/(app)/train',
	'/(app)/progress',
	'/(app)/coach/[[thread]]',
	'/(app)/profile'
] as const;

/**
 * What StatusSlot loads only on Graphite 2004, the Status Displays and the week strip's legend
 * (their own imports stay out with them).
 */
export const GRAPHITE_ONLY = [
	'src/routes/(app)/today/panels/TodayStatus.svelte',
	'src/routes/(app)/today/panels/WeekLegend.svelte',
	'src/routes/workout/run/RunStatus.svelte'
] as const;

/** One chunk of Vite's client manifest (`.vite/manifest.json`, keyed by source). */
export interface ViteChunk {
	file: string;
	isEntry?: boolean;
	imports?: string[];
	dynamicImports?: string[];
	css?: string[];
	assets?: string[];
}

/** A route of SvelteKit's server manifest: its page's node indexes. */
export interface ScopeRoute {
	id: string;
	page: {
		layouts: (number | undefined)[];
		errors: (number | undefined)[];
		leaf: number;
	} | null;
}

/** The parts of a client build the scope is computed from. */
export interface BuildGraph {
	vite: Record<string, ViteChunk>;
	/** SvelteKit's client entry: its scripts and stylesheets (manifest `client`). */
	entry: string[];
	routes: ScopeRoute[];
	/** A node's own files (its script, stylesheets and fonts), from the server's node module. */
	nodeFiles: (index: number) => string[];
}

/** The build files (`_app/immutable/…`, as `$app/manifest` names them) to precache, sorted. */
export function shellFiles(graph: BuildGraph): string[] {
	const keyOf = new Map(Object.entries(graph.vite).map(([key, chunk]) => [chunk.file, key]));
	const routeOf = (id: string) => {
		const route = graph.routes.find((r) => r.id === id);
		if (!route?.page) throw new Error(`precache: the build has no page ${id}`);
		return route.page;
	};
	const files = (indexes: (number | undefined)[]) =>
		indexes.filter((i) => i !== undefined).flatMap((i) => graph.nodeFiles(i));

	const graphiteOnly = new Set<string>(GRAPHITE_ONLY);
	for (const key of graphiteOnly) {
		if (!graph.vite[key]) throw new Error(`precache: the build has no ${key}`);
	}

	const seen = new Set<string>();
	/** Adds `roots` and what they import; with `lazy`, their dynamic imports too (never a node). */
	const walk = (roots: string[], lazy: boolean) => {
		const queue = [...roots];
		while (queue.length) {
			const file = queue.pop()!;
			if (seen.has(file)) continue;
			seen.add(file);
			const chunk = graph.vite[keyOf.get(file) ?? ''];
			if (!chunk) continue;
			for (const key of chunk.imports ?? []) queue.push(graph.vite[key]!.file);
			queue.push(...(chunk.css ?? []), ...(chunk.assets ?? []));
			if (!lazy) continue;
			// SvelteKit's app entry imports every route node dynamically: those are routes, not code
			// this page loads, so a node only comes in through a route listed above.
			for (const key of chunk.dynamicImports ?? []) {
				if (!graph.vite[key]!.isEntry && !graphiteOnly.has(key)) queue.push(graph.vite[key]!.file);
			}
		}
	};

	const tabs = TAB_PAGES.map(routeOf);
	walk(
		[
			...graph.entry,
			...OFFLINE_PAGES.map(routeOf).flatMap((page) =>
				files([...page.layouts, ...page.errors, page.leaf])
			),
			...tabs.flatMap((page) => files([...page.layouts, ...page.errors]))
		],
		true
	);
	walk(
		tabs.flatMap((page) => files([page.leaf])),
		false
	);
	return [...seen].sort();
}

/** Reads the graph from a build's output directory (`.svelte-kit/output`) without running app code. */
export async function readBuildGraph(out: string): Promise<BuildGraph> {
	const vite = JSON.parse(
		readFileSync(path.join(out, 'client/.vite/manifest.json'), 'utf8')
	) as Record<string, ViteChunk>;
	const { manifest } = (await import(
		pathToFileURL(path.resolve(out, 'server/manifest-full.js')).href
	)) as {
		manifest: { client: { imports: string[]; stylesheets: string[] }; routes: ScopeRoute[] };
	};
	return {
		vite,
		entry: [...manifest.client.imports, ...manifest.client.stylesheets],
		routes: manifest.routes,
		nodeFiles: (index) => {
			const source = readFileSync(path.join(out, `server/nodes/${index}.js`), 'utf8');
			// SvelteKit writes all three on every node: a missing one means its format changed, and
			// reading it as empty would quietly shrink the precache instead of failing the build.
			const list = <T>(name: string): T[] => {
				const found = new RegExp(`export const ${name} = (\\[.*?\\]);`).exec(source)?.[1];
				if (found === undefined) {
					throw new Error(`precache: server/nodes/${index}.js has no ${name} export`);
				}
				return JSON.parse(found) as T[];
			};
			return [
				...list<string>('imports'),
				...list<string>('stylesheets'),
				...list<{ file: string }>('fonts').map((font) => font.file)
			];
		}
	};
}
