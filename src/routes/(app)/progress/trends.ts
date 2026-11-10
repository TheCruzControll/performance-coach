/**
 * Overview's code-split trends: the KPI tiles and the headline charts (OverviewTrends), the part
 * of Progress that is not the verdict in words. +page.ts starts the import in parallel with the
 * page's own code and never waits for it in the browser: the server renders the section as static
 * markup (`servedTrends`), which the page keeps as sent until the code arrives (TrendsLoader).
 * The verdicts that answer 'am I improving?' stay in the view's own chunk (docs/performance.md).
 *
 * Not in +page.ts: scripts/check-budgets.ts counts an import written in a universal load's own
 * source as initial JS, and the load only starts this one, as Today's do with their panels.
 */
import type { Component } from 'svelte';
import type { OverviewData } from './load';

export interface TrendsProps {
	overview: OverviewData;
}

export const importTrends = (): Promise<{ default: Component<TrendsProps> }> =>
	import('./OverviewTrends.svelte');

/**
 * What the browser's load passes for the section the server rendered, while Progress hydrates:
 * any markup will do, as TrendsLoader keeps the server's (ServedInPlace).
 */
export const SERVED_IN_PLACE = 'served';

/** What the latest import came to: the component, or the error it failed with. */
let settled: Component<TrendsProps> | Error | undefined;

/**
 * Import the section and record what that came to. Never rejects: a failed import (offline, or a
 * chunk gone after a deploy) is recorded for TrendsLoader to offer Retry, and the next call
 * imports again.
 */
export async function preloadTrends(): Promise<void> {
	try {
		settled = (await importTrends()).default;
	} catch (error) {
		settled = error instanceof Error ? error : new Error(String(error));
	}
}

/** The section's component once imported, its error if the latest import failed, else undefined. */
export function settledTrends(): Component<TrendsProps> | Error | undefined {
	return settled;
}

/**
 * The section's markup as static HTML for the server to send in its place, or undefined if its
 * import failed (the browser then imports it again). Its ids ($props.id) are prefixed, as this
 * render counts apart from the page's. Server only: `import.meta.env.SSR` keeps the renderer out
 * of the browser's build.
 */
export async function servedTrends(props: TrendsProps): Promise<string | undefined> {
	const server = import.meta.env.SSR ? await import('svelte/server') : undefined;
	if (!server) throw new Error('The trends are served by the server only');
	await preloadTrends();
	const Trends = settledTrends();
	return Trends instanceof Error || !Trends
		? undefined
		: server.render(Trends, { props, idPrefix: 'trends' }).body;
}
