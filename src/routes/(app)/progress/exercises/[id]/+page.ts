import { browser } from '$app/env';
import { resolve } from '$app/paths';
import type { PageLoad } from './$types';
import { preloadTrends, servedTrends, SERVED_IN_PLACE } from './trends';

/**
 * Whether the next load hydrates the server's HTML: only the first one in a document opened on
 * an exercise, which keeps the server's markup of the trends as sent until their code arrives,
 * so hydration never waits for it (trends.ts). Any later load (a period link, another lift, a
 * preload on hover, Retry) shows the trends' placeholders until their code arrives.
 */
let hydrating = browser && location.pathname.startsWith(`${resolve('/(app)/progress')}/exercises/`);

export const load: PageLoad = async ({ data }) => {
	const kept = hydrating;
	hydrating = false;
	if (data.failed) return { ...data, served: undefined };
	// Started, never awaited in the browser: a failed import shows Retry in place of the trends.
	if (browser) {
		void preloadTrends();
		return { ...data, served: kept ? SERVED_IN_PLACE : undefined };
	}
	return { ...data, served: await servedTrends({ detail: data.detail }) };
};
