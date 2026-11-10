/**
 * The exercise detail's code-split trends (ExerciseTrends): the best e1RM tile with its context
 * and the profile's maxes, the e1RM chart, the rep-max table, the PRs, top sets, RPE and the
 * recent sessions, everything under the header's verdict. +page.ts starts the import in parallel
 * with the page's own code and never waits for it in the browser: the server renders the section
 * as static markup (`servedTrends`), which the page keeps as sent until the code arrives
 * (TrendsLoader). The verdict that answers 'is this lift going up?' (and, before trends, when they
 * appear) stays in the page's own chunk, as Overview's verdicts do (../../trends.ts).
 *
 * Not in +page.ts: scripts/check-budgets.ts counts an import written in a universal load's own
 * source as initial JS, and the load only starts this one.
 */
import type { Component } from 'svelte';
import type { ExerciseDetail } from './load';

export interface TrendsProps {
	detail: ExerciseDetail;
}

export const importTrends = (): Promise<{ default: Component<TrendsProps> }> =>
	import('./ExerciseTrends.svelte');

/**
 * What the browser's load passes for the section the server rendered, while the page hydrates:
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
