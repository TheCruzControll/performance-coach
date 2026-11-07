/**
 * The root layout's start for preferences.svelte.ts, loaded after the first render: the saved
 * theme is already applied (src/app.html), so only screens that show a preference have the module
 * in their initial JS. A separate module so that the root layout's `import()` costs those screens
 * nothing.
 */
import { applyTheme, preferences } from './preferences.svelte.ts';

export function startPreferences(): void {
	preferences.load();
	applyTheme(preferences.theme);
}
