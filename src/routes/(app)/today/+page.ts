import { browser } from '$app/env';
import { resolve } from '$app/paths';
import {
	PANELS,
	preloadPanel,
	servedPanel,
	settledPanel,
	SERVED_IN_PLACE,
	type PanelName
} from './panels';
import type { PageLoad } from './$types';

/**
 * Whether the next load hydrates the server's HTML: only the first one in a document opened on
 * Today. The server renders the state's panels into the page as static markup (their copy is the
 * screen's largest paint), and the browser keeps it as sent until each panel's code arrives, so
 * hydration never waits for that code: the screen's initial JavaScript holds only what every
 * state shares (docs/performance.md). Any later load (a client navigation to Today, a preload on
 * hover, an invalidation) shows the panels' skeletons until their code arrives.
 */
let hydrating = browser && location.pathname === resolve('/(app)/today');

/**
 * The state's panels: the setup card until onboarding is complete; then the Build card over the
 * summary while there is no program, else the summary alone.
 */
function statePanels({ setup, program }: Parameters<PageLoad>[0]['data']): PanelName[] {
	if (!setup) return [];
	if (!setup.complete) return ['setup'];
	return program === 'none' ? ['build', 'summary'] : ['summary'];
}

/**
 * Starts the state's panel imports, in parallel with the page's own code. A failed import never
 * fails the screen: the panel shows its Retry notice, the rest works.
 */
export const load: PageLoad = async ({ data }) => {
	const kept = hydrating;
	hydrating = false;
	const panels = statePanels(data);
	const imported = Promise.all(panels.map((name) => preloadPanel(PANELS[name])));
	const served: Partial<Record<PanelName, string>> = {};
	if (browser) {
		if (kept) for (const name of panels) served[name] = SERVED_IN_PLACE;
		return { ...data, served };
	}
	await imported;
	for (const name of panels) {
		const Panel = settledPanel(PANELS[name]);
		if (Panel && !(Panel instanceof Error)) {
			served[name] = await servedPanel(Panel, { setup: data.setup });
		}
	}
	return { ...data, served };
};
