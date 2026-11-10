import { browser } from '$app/env';
import { resolve } from '$app/paths';
import type { PageLoad } from './$types';
import type { ProgressView } from './params';
import { preloadTrends, servedTrends, SERVED_IN_PLACE } from './trends';

/**
 * Each view as a string-literal relative import, awaited on the server and in the browser alike
 * (no SSR guard): the server renders the view's verdicts, so a no-JS period link and first paint
 * never wait for a chunk, and nothing moves at hydration. Each later view adds one entry.
 */
const VIEWS = {
	overview: () => import('./OverviewView.svelte')
} as const satisfies Record<ProgressView, () => Promise<unknown>>;

/**
 * Whether the next load hydrates the server's HTML: only the first one in a document opened on
 * Progress, which keeps the server's markup of Overview's trends as sent until their code
 * arrives, so hydration never waits for it (trends.ts). Any later load (a period link, a preload
 * on hover, Retry) shows the trends' skeleton until their code arrives.
 */
let hydrating = browser && location.pathname === resolve('/(app)/progress');

export const load: PageLoad = async ({ data }) => {
	const kept = hydrating;
	hydrating = false;
	if (data.failed) return { ...data, View: null, served: undefined };
	// Started, never awaited in the browser: a failed import shows Retry in place of the trends.
	if (browser) void preloadTrends();
	const View = (await VIEWS[data.view]()).default;
	if (browser) return { ...data, View, served: kept ? SERVED_IN_PLACE : undefined };
	return { ...data, View, served: await servedTrends({ overview: data.overview }) };
};
