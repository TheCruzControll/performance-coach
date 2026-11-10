import { browser } from '$app/env';
import { resolve } from '$app/paths';
import type { PageLoad } from './$types';
import type { ProgressView } from './params';
import {
	preloadRunningTrends,
	preloadStrengthTrends,
	preloadTrends,
	servedRunningTrends,
	servedStrengthTrends,
	servedTrends,
	SERVED_IN_PLACE
} from './trends';

/**
 * Each view as a string-literal relative import, awaited on the server and in the browser alike
 * (no SSR guard): the server renders the view's verdicts, so a no-JS period link and first paint
 * never wait for a chunk, and nothing moves at hydration. Each later view adds one entry.
 */
const VIEWS = {
	overview: () => import('./OverviewView.svelte'),
	strength: () => import('./StrengthView.svelte'),
	running: () => import('./RunningView.svelte')
} as const satisfies Record<ProgressView, () => Promise<unknown>>;

/** Each loaded view's data with its own component, so the page passes it the props it takes. */
type WithView<D> = D extends { failed: false; view: infer V extends ProgressView }
	? D & { View: Awaited<ReturnType<(typeof VIEWS)[V]>>['default']; served: string | undefined }
	: D & { View: null; served: undefined };

/**
 * Whether the next load hydrates the server's HTML: only the first one in a document opened on
 * Progress, which keeps the server's markup of the view's trends as sent until their code
 * arrives, so hydration never waits for it (trends.ts). Any later load (a period link, a preload
 * on hover, Retry) shows Overview's skeleton until its trends' code arrives, and waits for
 * Strength's or Running's.
 */
let hydrating = browser && location.pathname === resolve('/(app)/progress');

export const load: PageLoad = async ({ data }) => {
	const kept = hydrating;
	hydrating = false;
	if (data.failed) return { ...data, View: null, served: undefined } as WithView<typeof data>;
	// Strength's and Running's trends start with the view's own import: any load but the
	// hydrating one waits for both, as it does for the view, so the view arrives whole (trends.ts).
	const trends = !browser
		? undefined
		: data.view === 'strength'
			? preloadStrengthTrends()
			: data.view === 'running'
				? preloadRunningTrends()
				: undefined;
	const View = (await VIEWS[data.view]()).default;
	if (browser) {
		if (trends && !kept) await trends;
		// Started, never awaited: a failed import shows Retry in place of Overview's trends.
		if (data.view === 'overview') void preloadTrends();
		const served = kept ? SERVED_IN_PLACE : undefined;
		return { ...data, View, served } as WithView<typeof data>;
	}
	const served =
		data.view === 'strength'
			? await servedStrengthTrends({ strength: data.strength })
			: data.view === 'running'
				? await servedRunningTrends({ running: data.running })
				: await servedTrends({ overview: data.overview });
	return { ...data, View, served } as WithView<typeof data>;
};
