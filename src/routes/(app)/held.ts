/**
 * What the (app) layout draws over the content while a navigation to another tab loads
 * (HeldScreen.svelte). Loaded with HeldScreen, once the first frame has painted, so none of it
 * is in any screen's initial JavaScript (docs/performance.md).
 */
import { isTabRoot, screenName, tabFor } from './nav';

/** A navigation's end, as SvelteKit's read-only URLs and plain ones both have it. */
export type Where = Pick<URL, 'origin' | 'pathname' | 'search'>;

/** What shows in place of the screen while a navigation to another one loads. */
export interface Held<T> {
	/** The screen's name, for the loading announcement. */
	label: string;
	/** The last screen that URL showed (screen-memory.ts), or null for the tab's skeleton. */
	last: T | null;
}

/**
 * While a navigation from `from` to `to` loads: the last screen `to` showed when one is kept,
 * else, for another tab's own screen, that tab's skeleton. Nothing for a change of query on the
 * same screen (it shows its own pending state), or for a sub-screen (never kept: the
 * current screen stays until it arrives, as before).
 */
export function heldFor<T>(
	from: Where,
	to: Where | null | undefined,
	recall: (url: Where) => T | undefined
): Held<T> | null {
	if (!to || to.origin !== from.origin || to.pathname === from.pathname) return null;
	const label = screenName(to.pathname);
	if (!label) return null;
	const last = recall(to);
	if (last !== undefined) return { label, last };
	return isTabRoot(to.pathname) && tabFor(to.pathname) !== tabFor(from.pathname)
		? { label, last: null }
		: null;
}
