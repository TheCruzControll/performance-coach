/**
 * What Today's code-split panels (+page.ts `_PANELS`) need at run time. +page.ts imports the
 * state's panel (`preloadPanel`) and, while hydrating, waits for it, so the browser hydrates the
 * markup the server rendered. PanelLoader then renders what the import came to: the panel, its
 * skeleton while it loads, or 'Couldn’t load this part of Today' with Retry.
 */
import type { Component } from 'svelte';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any panel's props
export type PanelImport<P extends Record<string, any> = any> = () => Promise<{
	default: Component<P>;
}>;

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
