/**
 * Applies the theme preference (preferences.svelte.ts) to the page: the profile's theme picker and
 * the root layout's start (preferences-start.ts). Apart from the preferences, so the screens that
 * only show a unit (Today, Train) do not ship it in their initial JavaScript.
 */
import { preferences, type ThemePreference } from './preferences.svelte.ts';

const THEME_COLORS = { dark: '#0a0a0b', light: '#f4f4f0' } as const;

let systemScheme: MediaQueryList | undefined;
const followSystem = () => applyTheme('system');

/**
 * Apply a theme to the document and the browser chrome. With 'system' (Auto) it also keeps
 * following the OS: when iOS switches appearance while the app is open (e.g. automatic dark mode
 * at sunset) the CSS follows by itself, and this listener updates the theme-color and status-bar
 * metas to match. Any other theme removes the listener.
 */
export function applyTheme(theme: ThemePreference): void {
	const root = document.documentElement;
	if (theme === 'dark') delete root.dataset.theme;
	else root.dataset.theme = theme;
	systemScheme ??= window.matchMedia('(prefers-color-scheme: light)');
	// Same function reference: adding twice is a no-op, so this is safe to call repeatedly.
	if (theme === 'system') systemScheme.addEventListener('change', followSystem);
	else systemScheme.removeEventListener('change', followSystem);
	const light = theme === 'light' || (theme === 'system' && systemScheme.matches);
	document
		.querySelector('meta[name="theme-color"]')
		?.setAttribute('content', light ? THEME_COLORS.light : THEME_COLORS.dark);
	// iOS reads the status-bar style when an installed web app launches: white text over the
	// dark canvas (translucent, content runs under it), dark text in a light status bar.
	document
		.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')
		?.setAttribute('content', light ? 'default' : 'black-translucent');
}

/** Save `theme` as this device's preference and apply it. */
export function setTheme(theme: ThemePreference): void {
	preferences.storeTheme(theme);
	applyTheme(theme);
}
