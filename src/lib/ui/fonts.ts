/**
 * Font preloading policy, shared by `hooks.server.ts` (which emits the <link rel=preload>
 * tags) and `scripts/check-budgets.ts` (which enforces "≤ 2 preloaded font files").
 * Only the two latin variable faces used above the fold are preloaded.
 */
export const PRELOADED_FONT_PATTERN = /(mona|hubot)-sans-latin-wght-normal\.woff2$/;

export function shouldPreloadFont(filename: string): boolean {
	return PRELOADED_FONT_PATTERN.test(filename);
}
