/**
 * Font preloading policy, shared by `hooks.server.ts` (which emits the <link rel=preload>
 * tags) and `scripts/check-budgets.ts` (which enforces "≤ 2 preloaded font files").
 *
 * Geist latin (UI, titles and body) and Geist Mono latin (labels, the tab bar and every number)
 * are preloaded: every screen paints its text and numbers in one or both from the first frame.
 * Both are the latin wght-normal file only; latin-ext and any other file wait for their
 * unicode-range (src/lib/ui/styles/fonts.css), so the preloads stay at two.
 */
export const PRELOADED_FONT_PATTERN = /(geist-latin|geist-mono-latin)-wght-normal\.woff2$/;

export function shouldPreloadFont(filename: string): boolean {
	return PRELOADED_FONT_PATTERN.test(filename);
}
