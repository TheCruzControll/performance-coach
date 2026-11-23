/**
 * The app's primary navigation. Shared by the (app) layout and by the root error page, which
 * keeps the shell (and the way back) when a screen fails to load, e.g. offline.
 */
import { resolve } from '$app/paths';
import type { NavItem } from '#lib/ui/components/AppNav.svelte';

/** The four tabs (Instrument v2): what the tab bar and the rail show. */
export const APP_NAV: NavItem[] = [
	{ href: resolve('/(app)/today'), label: 'Today', icon: 'today' },
	{ href: resolve('/(app)/train'), label: 'Train', icon: 'train' },
	{ href: resolve('/(app)/progress'), label: 'Progress', icon: 'progress' },
	{ href: resolve('/(app)/coach/[[thread]]', {}), label: 'Coach', icon: 'coach' }
];

/** Profile: not a tab; opened from the avatar on Today and at the foot of the rail. */
export const PROFILE: NavItem = {
	href: resolve('/(app)/profile'),
	label: 'Profile',
	icon: 'profile'
};

/** Every screen of the shell with its own root: the tabs and Profile. */
const APP_SCREENS: readonly NavItem[] = [...APP_NAV, PROFILE];

const OFFLINE_PATH = resolve('/(app)/offline');

/** The tab or Profile a URL belongs to: its own screen or one of its sub-screens. */
export const tabFor = (pathname: string) =>
	APP_SCREENS.find(({ href }) => pathname === href || pathname.startsWith(`${href}/`));

/** True for URLs that belong to the app shell (tabs, Profile, their sub-screens, the offline screen). */
export function isAppPath(pathname: string): boolean {
	return pathname === OFFLINE_PATH || tabFor(pathname) !== undefined;
}

/** True for a tab's or Profile's own screen, e.g. `/progress` (not `/progress/exercises/1`). */
export function isTabRoot(pathname: string): boolean {
	return APP_SCREENS.some(({ href }) => href === pathname);
}

/** The screen name for a URL, e.g. `/profile` → `Profile` (undefined outside the shell's screens). */
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
