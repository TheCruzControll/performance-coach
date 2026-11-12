/**
 * Per-device display preferences (theme, weight and distance units), persisted in localStorage.
 *
 * These are device conveniences, not training data: the canonical unit preference moves to
 * the user profile in Postgres in M2. The theme is applied before first paint by the inline
 * script in src/app.html (same storage key), so there is no flash of the wrong theme, and after
 * that by theme.ts, which the screens that only show a unit (Today, Train) do not load.
 */
import type { DistanceUnit, WeightUnit } from '#lib/domain/units.ts';

export type ThemePreference = 'dark' | 'light' | 'system';
/** Distances the athlete thinks in (metres are for storage, never a display preference). */
export type DistancePreference = Exclude<DistanceUnit, 'm'>;

export const PREFERENCES_KEY = 'pc:prefs:v1';

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

	/** Saves the theme; theme.ts applies it to the page. */
	storeTheme(theme: ThemePreference): void {
		this.load();
		this.theme = theme;
		this.#save();
	}

	setUnits(units: WeightUnit): void {
		this.load();
		this.units = units;
		this.#save();
	}

	setDistance(distance: DistancePreference): void {
		this.load();
		this.distance = distance;
		this.#save();
	}

	/** Writes all three, so each setter loads the saved ones first. */
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

export const preferences = new Preferences();
