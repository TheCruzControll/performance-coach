/**
 * Running's and General's layout as style attributes, not stylesheets: every view's CSS is linked
 * render-blocking on /progress, whose CSS budget has no room left, and these cost no CSS file.
 * Columns go by the room there is, with no container query: two a row from about 38 rem, three
 * from about 57 rem (desktop).
 */

/** A stack (or a bare list) with the small gap. */
export const GRID =
	'display:grid;gap:var(--space-3);min-width:0;margin:0;padding:0;list-style:none';
/** A stack of sections. */
export const WIDE = `${GRID};gap:var(--space-6)`;
/** Sections or small multiples side by side as the room allows. */
export const COLS = `${WIDE};grid-template-columns:repeat(auto-fit,minmax(min(100%,18.5rem),1fr));align-items:start`;
/** A secondary line of text. */
export const LINE = 'color:var(--color-text-secondary);font-size:var(--text-sm)';
