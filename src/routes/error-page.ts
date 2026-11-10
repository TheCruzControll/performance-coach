/**
 * The root error page, loaded on demand.
 *
 * SvelteKit imports the root layout and the root error page before it hydrates any page (3.1:
 * `start` in its client), so whatever src/routes/+error.svelte imports statically is a step on
 * every route's start-up, however rarely an error shows: the app shell, the error view and their
 * stylesheets were 5 scripts and 3 stylesheets fetched after the app had started. +error.svelte
 * now imports only this module, and the page itself (ErrorPage.svelte) loads:
 * - on the server, and in the browser on an error page the server rendered, before the page
 *   renders or hydrates (a top-level await in +error.svelte, which SvelteKit awaits);
 * - otherwise as soon as the page has hydrated (the root layout), so an error after that, offline
 *   included, renders at once without the network, as SvelteKit's eager import did. Not in an
 *   idle period: WebKit has no requestIdleCallback, and in its 1.5 s fallback delay a screen
 *   opened offline (no service worker yet, or one blocked) lost its designed offline state.
 * An error before then shows once the import arrives ({#await} in +error.svelte).
 *
 * The `import()` itself stays in +error.svelte, a node no route's build walks: SvelteKit lists a
 * route's modulepreloads and stylesheets by walking its imports, and a chunk it first meets
 * through a dynamic import is left out (its `find_deps`). In this module, which every page
 * loads, the import hid the chunks the error page shares with screens (Button, EmptyState) and
 * their stylesheets from every route.
 */
import type { Component } from 'svelte';

export interface Lazy<T> {
	/** The value once it has loaded (synchronously, for {#await} and hydration), else its load. */
	current(): T | Promise<T>;
	/** Loads it once; a failed load is tried again on the next call. */
	load(): Promise<T>;
}

export function lazy<T>(importer: () => Promise<T>): Lazy<T> {
	let loaded: { value: T } | undefined;
	let pending: Promise<T> | undefined;
	const load = () =>
		(pending ??= importer().then(
			(value) => {
				loaded = { value };
				return value;
			},
			(error: unknown) => {
				pending = undefined;
				throw error;
			}
		));
	return { current: () => (loaded ? loaded.value : load()), load };
}

let importPage: (() => Promise<{ default: Component }>) | undefined;

/** How to import the page: given by +error.svelte, which SvelteKit loads before any hydration. */
export function provideErrorPage(importer: () => Promise<{ default: Component }>): void {
	importPage = importer;
}

export const errorPage: Lazy<Component> = lazy(async () => {
	if (!importPage) throw new Error('The root error page has not been provided yet');
	return (await importPage()).default;
});

/**
 * Load the error page now: the root layout calls this once the page has hydrated, off the
 * start-up path. A failure is no error: the page loads again when an error needs it.
 */
export function loadErrorPage(page: Lazy<unknown> = errorPage): void {
	void page.load().catch(() => {});
}
