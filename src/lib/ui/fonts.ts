/**
 * Font preloading policy, shared by `hooks.server.ts` (which emits the <link rel=preload>
 * tags) and `scripts/check-budgets.ts` (which enforces "≤ 2 preloaded font files").
 *
 * Mona Sans latin is preloaded: every screen paints its text and every numeral in it from the
 * first frame. It is the latin wght-normal file only. Hubot Sans (the one display line on a
 * screen) and latin-ext wait for their unicode-range or first use (src/lib/ui/styles/fonts.css),
 * behind a metric-matched fallback, so the preloads stay at one (commit 1352d2b0).
 */
export const PRELOADED_FONT_PATTERN = /mona-sans-latin-wght-normal\.woff2$/;

export function shouldPreloadFont(filename: string): boolean {
	return PRELOADED_FONT_PATTERN.test(filename);
}
