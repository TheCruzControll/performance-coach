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

/** The tab a URL belongs to: its own screen or one of its sub-screens. */
export const tabFor = (pathname: string) =>
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
