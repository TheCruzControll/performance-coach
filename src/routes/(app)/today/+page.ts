import { browser } from '$app/env';
import { resolve } from '$app/paths';
import { preloadPanel, type PanelImport } from './panels';
import type { PageLoad } from './$types';

/**
 * Today's state panels, each code-split so the screen's initial JavaScript holds only what every
 * state shares (docs/performance.md): M3's states add theirs here. The imports are written in
 * this file on purpose: scripts/check-budgets.ts counts the ones it finds in a universal load's
 * own source as initial JS, because the load below awaits one before the page hydrates.
 */
export const _PANELS = {
	/** Onboarding is incomplete: the setup card. */
	setup: () => import('./panels/Setup.svelte'),
	/** Onboarding is complete: the goals by rank and the shape of the week. */
	summary: () => import('./panels/Summary.svelte')
} satisfies Record<string, PanelImport>;

/**
 * Whether the next load hydrates the server's HTML: only the first one in a document opened on
 * Today. The server renders the state's panel into the page (its copy is the screen's largest
 * paint), so that load awaits the panel's code and hydration finds the same markup. Any later
 * load (a client navigation to Today, a preload on hover, an invalidation) starts the import and
 * returns at once: Today shows straight away, with the panel's skeleton until its code arrives.
 */
let hydrating = browser && location.pathname === resolve('/(app)/today');

/** A failed import never fails the screen: the panel shows its Retry notice, the rest works. */
export const load: PageLoad = async ({ data }) => {
	const wait = !browser || hydrating;
	hydrating = false;
	const panel = data.setup && (data.setup.complete ? _PANELS.summary : _PANELS.setup);
	if (panel) {
		const imported = preloadPanel(panel);
		if (wait) await imported;
	}
	return data;
};
