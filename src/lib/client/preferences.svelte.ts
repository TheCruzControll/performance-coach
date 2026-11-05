/**
 * Per-device display preferences (theme, units), persisted in localStorage.
 *
 * These are device conveniences, not training data: the canonical unit preference moves to
 * the user profile in Postgres in M2. The theme is applied before first paint by the inline
 * script in src/app.html (same storage key), so there is no flash of the wrong theme.
 */
import type { WeightUnit } from '#lib/domain/units.ts';

export type ThemePreference = 'dark' | 'light' | 'system';

export const PREFERENCES_KEY = 'pc:prefs:v1';
const THEME_COLORS = { dark: '#0a0a0b', light: '#f4f4f0' } as const;

interface Stored {
	theme?: ThemePreference;
	units?: WeightUnit;
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

	#save(): void {
		try {
			localStorage.setItem(
				PREFERENCES_KEY,
				JSON.stringify({ theme: this.theme, units: this.units })
			);
		} catch {
			// Private mode / storage disabled: preferences simply don't persist.
		}
	}
}

export function applyTheme(theme: ThemePreference): void {
	const root = document.documentElement;
	if (theme === 'dark') delete root.dataset.theme;
	else root.dataset.theme = theme;
	const light =
		theme === 'light' ||
		(theme === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
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
