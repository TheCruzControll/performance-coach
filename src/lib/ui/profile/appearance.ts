/**
 * Profile → Appearance (Paper, 9 · Profile, "Appearance"): the themes this device can take, in
 * the order the list shows them, and the words Profile's Appearance row ends with.
 */
import type { ThemePreference } from '#lib/client/preferences.svelte.ts';

export const THEMES = [
	{ value: 'dark', label: 'Dark' },
	{ value: 'light', label: 'Light' },
	{ value: 'system', label: 'Match my phone' }
] as const satisfies readonly { value: ThemePreference; label: string }[];

/** "Dark", "Light", "Match my phone": a theme as its row says it. */
export const themeLabel = (theme: ThemePreference) => THEMES.find((t) => t.value === theme)!.label;
