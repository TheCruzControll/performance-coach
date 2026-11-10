/**
 * Font preloading policy, shared by `hooks.server.ts` (which emits the <link rel=preload>
 * tags) and `scripts/check-budgets.ts` (which enforces "≤ 2 preloaded font files").
 *
 * Only Mona Sans latin is preloaded: every screen paints its text and numbers in it from the
 * first frame. Hubot Sans (headings) is fetched once a heading uses it, so its 48 KB no longer
 * share the connection with the app's start-up on every route; until it arrives a heading shows
 * in its metric-matched fallback (src/lib/ui/styles/fonts.css), so the swap does not shift layout.
 */
export const PRELOADED_FONT_PATTERN = /mona-sans-latin-wght-normal\.woff2$/;

export function shouldPreloadFont(filename: string): boolean {
	return PRELOADED_FONT_PATTERN.test(filename);
}
