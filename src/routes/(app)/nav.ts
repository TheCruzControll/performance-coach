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
	{ href: resolve('/(app)/coach'), label: 'Coach', icon: 'coach' },
	{ href: resolve('/(app)/profile'), label: 'Profile', icon: 'profile' }
];

const OFFLINE_PATH = resolve('/(app)/offline');

const tabFor = (pathname: string) =>
	APP_NAV.find(({ href }) => pathname === href || pathname.startsWith(`${href}/`));

/** True for URLs that belong to the app shell (tabs, their sub-screens, the offline screen). */
export function isAppPath(pathname: string): boolean {
	return pathname === OFFLINE_PATH || tabFor(pathname) !== undefined;
}

/** The tab name for a URL, e.g. `/profile` → `Profile` (undefined outside the tabs). */
export function screenName(pathname: string): string | undefined {
	return tabFor(pathname)?.label;
}
