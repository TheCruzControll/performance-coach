/**
 * Today's code-split panels and what they need at run time. +page.ts imports the state's panel
 * (`preloadPanel`) in parallel with the page's own code and never waits for it in the browser:
 * the server renders it as static markup (`servedPanel`), which the page keeps as sent until the
 * code arrives. PanelLoader then renders what the import came to: the panel, its skeleton while
 * it loads, or 'Couldn’t load this part of Today' with Retry.
 */
import type { Component } from 'svelte';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any panel's props
export type PanelImport<P extends Record<string, any> = any> = () => Promise<{
	default: Component<P>;
}>;

/**
 * Today's state panels, one per state that has one: M3's states add theirs here. Not in +page.ts:
 * scripts/check-budgets.ts counts an import written in a universal load's own source as initial
 * JS, and the load only starts these (docs/performance.md).
 */
export const PANELS = {
	/** Onboarding is incomplete: the setup card. */
	setup: () => import('./Setup.svelte'),
	/** Onboarding is complete: the goals by rank and the shape of the week. */
	summary: () => import('./Summary.svelte'),
	/** Onboarding is complete and there is no program: the Build card, over the summary. */
	build: () => import('./Build.svelte'),
	/**
	 * Build my program, once the Build card is tapped: week 1 previewed, then started. Browser
	 * only (the server never renders it): while the server can reach it, SvelteKit links its CSS
	 * into every Today page.
	 */
	preview: () =>
		import.meta.env.SSR ? Promise.reject(new Error('client only')) : import('./BuildPreview.svelte')
} satisfies Record<string, PanelImport>;

export type PanelName = keyof typeof PANELS;

/**
 * What the browser's load passes for a panel the server rendered, while Today hydrates: any
 * markup will do, as PanelLoader keeps the server's (ServedInPlace).
 */
export const SERVED_IN_PLACE = 'served';

/**
 * A panel's markup as static HTML for the server to send in its place. Server only:
 * `import.meta.env.SSR` keeps the renderer out of the browser's build, whose shared chunk it
 * would otherwise grow on every route.
 */
export async function servedPanel(Panel: Component, props: Record<string, unknown>) {
	const server = import.meta.env.SSR ? await import('svelte/server') : undefined;
	if (!server) throw new Error('A panel is served by the server only');
	return server.render(Panel, { props }).body;
}

/** What each panel's latest import came to: its component, or the error it failed with. */
const settled = new Map<PanelImport, Component | Error>();

/**
 * Import a panel and record what that came to. Never rejects: a failed import (offline, or a
 * chunk gone after a deploy) is recorded for PanelLoader to offer Retry, and the next call
 * imports again.
 */
export async function preloadPanel(load: PanelImport): Promise<void> {
	try {
		settled.set(load, (await load()).default);
	} catch (error) {
		settled.set(load, error instanceof Error ? error : new Error(String(error)));
	}
}

/** The panel's component once imported, its error if the latest import failed, else undefined. */
export function settledPanel(load: PanelImport): Component | Error | undefined {
	return settled.get(load);
}
