/**
 * Progress's code-split trends, one section per view, each in a chunk of its own:
 *
 * - Overview's (OverviewTrends): the KPI tiles and the headline charts, the part of Progress that
 *   is not the verdict in words. +page.ts starts the import in parallel with the page's own code
 *   and never waits for it in the browser; TrendsLoader holds the section's room until it arrives.
 *   The verdicts that answer 'am I improving?' stay in the view's own chunk (docs/performance.md).
 * - Strength's (StrengthTrends): the key lifts, volume, muscle groups, effort and PRs under the
 *   view's intro. A client navigation waits for it as it waits for the view's own chunk, both
 *   imports started together, so the frame holds busy and the view arrives whole
 *   (StrengthTrendsLoader).
 * - Running's (RunningTrends) and General's (GeneralTrends): everything under each view's intro,
 *   charts and all, loaded as Strength's are (ViewTrendsLoader).
 *
 * Either way the server renders the section as static markup (`served…`), which the page keeps as
 * sent until the code arrives, so hydration never waits for it.
 *
 * Not in +page.ts: scripts/check-budgets.ts counts an import written in a universal load's own
 * source as initial JS, and the load only starts these, as Today's do with their panels.
 */
import type { Component } from 'svelte';
import type { GeneralData } from './general-data';
import type { OverviewData } from './load';
import type { RunningData } from './running-data';
import type { StrengthData } from './strength-data';

export interface TrendsProps {
	overview: OverviewData;
}

export interface StrengthTrendsProps {
	strength: StrengthData;
}

export interface RunningTrendsProps {
	running: RunningData;
}

export interface GeneralTrendsProps {
	general: GeneralData;
}

/**
 * What the browser's load passes for the section the server rendered, while Progress hydrates:
 * any markup will do, as the loader keeps the server's (ServedInPlace).
 */
export const SERVED_IN_PLACE = 'served';

/** A section imported apart from its view, with what its latest import came to. */
function lazySection<P extends object>(importer: () => Promise<{ default: Component<P> }>) {
	/** What the latest import came to: the component, or the error it failed with. */
	let settled: Component<P> | Error | undefined;

	/**
	 * Import the section and record what that came to. Never rejects: a failed import (offline,
	 * or a chunk gone after a deploy) is recorded for the loader to offer Retry, and the next call
	 * imports again.
	 */
	async function preload(): Promise<void> {
		try {
			settled = (await importer()).default;
		} catch (error) {
			settled = error instanceof Error ? error : new Error(String(error));
		}
	}

	/**
	 * The section's markup as static HTML for the server to send in its place, or undefined if
	 * its import failed (the browser then imports it again). Its ids ($props.id) are prefixed, as
	 * this render counts apart from the page's. Server only: `import.meta.env.SSR` keeps the
	 * renderer out of the browser's build.
	 */
	async function served(props: P): Promise<string | undefined> {
		const server = import.meta.env.SSR ? await import('svelte/server') : undefined;
		if (!server) throw new Error('The trends are served by the server only');
		await preload();
		const Section = settled;
		return Section instanceof Error || !Section
			? undefined
			: server.render(Section as Component<Record<string, unknown>>, {
					props: props as Record<string, unknown>,
					idPrefix: 'trends'
				}).body;
	}

	/** The section's component once imported, its error if the latest import failed, else undefined. */
	return { preload, settled: (): Component<P> | Error | undefined => settled, served };
}

const overview = lazySection<TrendsProps>(() => import('./OverviewTrends.svelte'));
const strength = lazySection<StrengthTrendsProps>(() => import('./StrengthTrends.svelte'));
const running = lazySection<RunningTrendsProps>(() => import('./RunningTrends.svelte'));
const general = lazySection<GeneralTrendsProps>(() => import('./GeneralTrends.svelte'));

export const { preload: preloadTrends, settled: settledTrends, served: servedTrends } = overview;
export const {
	preload: preloadStrengthTrends,
	settled: settledStrengthTrends,
	served: servedStrengthTrends
} = strength;
export const {
	preload: preloadRunningTrends,
	settled: settledRunningTrends,
	served: servedRunningTrends
} = running;
export const {
	preload: preloadGeneralTrends,
	settled: settledGeneralTrends,
	served: servedGeneralTrends
} = general;
