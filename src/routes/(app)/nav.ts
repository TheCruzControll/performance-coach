/**
 * The app's primary navigation. Shared by the (app) layout and by the root error page, which
 * keeps the shell (and the way back) when a screen fails to load, e.g. offline.
 */
import { resolve } from '$app/paths';
import type { NavItem } from '#lib/ui/components/AppNav.svelte';

export const APP_NAV: NavItem[] = [
	{ href: resolve('/(app)/today'), label: 'Today', icon: 'today' },
	{ href: resolve('/(app)/train'), label: 'Train', icon: 'train' },
	{ href: resolve('/(app)/progress'), label: 'Progress', icon: 'progress' },
	{ href: resolve('/(app)/coach/[[thread]]', {}), label: 'Coach', icon: 'coach' },
	{ href: resolve('/(app)/profile'), label: 'Profile', icon: 'profile' }
];

const OFFLINE_PATH = resolve('/(app)/offline');

const tabFor = (pathname: string) =>
	APP_NAV.find(({ href }) => pathname === href || pathname.startsWith(`${href}/`));

/** True for URLs that belong to the app shell (tabs, their sub-screens, the offline screen). */
export function isAppPath(pathname: string): boolean {
	return pathname === OFFLINE_PATH || tabFor(pathname) !== undefined;
}

/** True for a tab's own screen, e.g. `/progress` (not `/progress/exercises/1`). */
export function isTabRoot(pathname: string): boolean {
	return APP_NAV.some(({ href }) => href === pathname);
}

/** The tab name for a URL, e.g. `/profile` → `Profile` (undefined outside the tabs). */
export function screenName(pathname: string): string | undefined {
	return tabFor(pathname)?.label;
}

/**
 * The URL the primary nav marks as current: where a navigation in progress is going, from the
 * moment it starts (not when its data arrives), when that is an app screen; else the page's own.
 */
export function activePath(pathname: string, to: Pick<URL, 'pathname'> | null | undefined): string {
	return to && isAppPath(to.pathname) ? to.pathname : pathname;
}

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
