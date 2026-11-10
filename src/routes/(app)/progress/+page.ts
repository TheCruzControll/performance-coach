import type { PageLoad } from './$types';
import type { ProgressView } from './params';

/**
 * Each view as a string-literal relative import, awaited on the server and in the browser alike
 * (no SSR guard): the server renders the view's numbers, verdicts and table twins, so a no-JS
 * period link and first paint never wait for a chunk, and nothing moves at hydration. Only chart
 * bodies load after hydration (ui/charts/bodies.ts). Each later view adds one entry.
 */
const VIEWS = {
	overview: () => import('./OverviewView.svelte'),
	strength: () => import('./StrengthView.svelte')
} as const satisfies Record<ProgressView, () => Promise<unknown>>;

/** Each loaded view's data with its own component, so the page passes it the props it takes. */
type WithView<D> = D extends { failed: false; view: infer V extends ProgressView }
	? D & { View: Awaited<ReturnType<(typeof VIEWS)[V]>>['default'] }
	: D & { View: null };

export const load: PageLoad = async ({ data }) =>
	({
		...data,
		View: data.failed ? null : (await VIEWS[data.view]()).default
	}) as WithView<typeof data>;
