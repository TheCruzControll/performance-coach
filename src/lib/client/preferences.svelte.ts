/**
 * Per-device display preferences (theme, weight and distance units), persisted in localStorage.
 *
 * These are device conveniences, not training data: the canonical unit preference moves to
 * the user profile in Postgres in M2. The theme is applied before first paint by the inline
 * script in src/app.html (same storage key), so there is no flash of the wrong theme.
 */
import type { DistanceUnit, WeightUnit } from '#lib/domain/units.ts';

export type ThemePreference = 'dark' | 'light' | 'system';
/** Distances the athlete thinks in (metres are for storage, never a display preference). */
export type DistancePreference = Exclude<DistanceUnit, 'm'>;

export const PREFERENCES_KEY = 'pc:prefs:v1';
const THEME_COLORS = { dark: '#0a0a0b', light: '#f4f4f0' } as const;

interface Stored {
	theme?: ThemePreference;
	units?: WeightUnit;
	distance?: DistancePreference;
}

function read(): Stored {
	try {
		return JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? '{}') as Stored;
	} catch {
		return {};
	}
}

class Preferences {
	theme = $state<ThemePreference>('dark');
	units = $state<WeightUnit>('kg');
	distance = $state<DistancePreference>('km');
	#loaded = false;

	/** Load from storage (browser only). Safe to call repeatedly. */
	load(): void {
		if (this.#loaded || typeof window === 'undefined') return;
		this.#loaded = true;
		const stored = read();
		if (stored.theme === 'dark' || stored.theme === 'light' || stored.theme === 'system') {
			this.theme = stored.theme;
		}
		if (stored.units === 'kg' || stored.units === 'lb') this.units = stored.units;
		if (stored.distance === 'km' || stored.distance === 'mi') this.distance = stored.distance;
	}

	setTheme(theme: ThemePreference): void {
		this.theme = theme;
		this.#save();
		applyTheme(theme);
	}

	setUnits(units: WeightUnit): void {
		this.units = units;
		this.#save();
	}

	setDistance(distance: DistancePreference): void {
		this.distance = distance;
		this.#save();
	}

	#save(): void {
		try {
			localStorage.setItem(
				PREFERENCES_KEY,
				JSON.stringify({ theme: this.theme, units: this.units, distance: this.distance })
			);
		} catch {
			// Private mode / storage disabled: preferences simply don't persist.
		}
	}
}

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

export const preferences = new Preferences();
