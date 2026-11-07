import { browser } from '$app/env';
import { resolve } from '$app/paths';
import { PANELS, preloadPanel, servedPanel, settledPanel, SERVED_IN_PLACE } from './panels';
import type { PageLoad } from './$types';

/**
 * Whether the next load hydrates the server's HTML: only the first one in a document opened on
 * Today. The server renders the state's panel into the page as static markup (its copy is the
 * screen's largest paint), and the browser keeps it as sent until the panel's code arrives, so
 * hydration never waits for that code: the screen's initial JavaScript holds only what every
 * state shares (docs/performance.md). Any later load (a client navigation to Today, a preload on
 * hover, an invalidation) shows the panel's skeleton until its code arrives.
 */
let hydrating = browser && location.pathname === resolve('/(app)/today');

/**
 * Starts the state's panel import, in parallel with the page's own code. A failed import never
 * fails the screen: the panel shows its Retry notice, the rest works.
 */
export const load: PageLoad = async ({ data }) => {
	const kept = hydrating;
	hydrating = false;
	const panel = data.setup && (data.setup.complete ? PANELS.summary : PANELS.setup);
	if (!panel) return { ...data, served: undefined };
	const imported = preloadPanel(panel);
	if (browser) return { ...data, served: kept ? SERVED_IN_PLACE : undefined };
	await imported;
	const Panel = settledPanel(panel);
	const served =
		Panel instanceof Error ? undefined : await servedPanel(Panel!, { setup: data.setup });
	return { ...data, served };
};
