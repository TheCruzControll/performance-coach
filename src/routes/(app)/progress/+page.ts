import type { PageLoad } from './$types';
import type { ProgressView } from './params';

/**
 * Each view as a string-literal relative import, awaited on the server and in the browser alike
 * (no SSR guard): the server renders the view's numbers, verdicts and table twins, so a no-JS
 * period link and first paint never wait for a chunk, and nothing moves at hydration. Only chart
 * bodies load after hydration (ui/charts/bodies.ts). Each later view adds one entry.
 */
const VIEWS = {
	overview: () => import('./OverviewView.svelte')
} as const satisfies Record<ProgressView, () => Promise<unknown>>;

export const load: PageLoad = async ({ data }) => ({
	...data,
	View: data.failed ? null : (await VIEWS[data.view]()).default
});
