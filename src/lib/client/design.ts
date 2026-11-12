/**
 * Which design this device shows: today's ('current', the default for everyone) or the Graphite
 * 2004 preview ('graphite'). A device setting like the theme, in localStorage under a key of its
 * own, so sign-out keeps it (signout.ts clears only account data) and the screens that set units
 * or the theme carry none of this code.
 *
 * The pre-paint script in src/app.html applies the saved choice (or ?design=graphite|current, which
 * it also saves) before first paint: `data-design` on <html>, and for Graphite its stylesheet
 * (src/lib/ui/styles/graphite.css) and a preload of Source Sans 3. It leaves `window.__pcDesign`
 * behind, which applies a choice made while the page is open, so the two never drift apart.
 */
export const DESIGNS = ['current', 'graphite'] as const;
export type Design = (typeof DESIGNS)[number];

/** Read by the pre-paint script in src/app.html too. */
export const DESIGN_KEY = 'pc:design:v1';

/**
 * Graphite's files in the build (`[name].[hash][extname]`, src/lib/server/design-assets.ts): the
 * service worker keeps them out of every device's install and caches them once a device uses them.
 */
export const DESIGN_ASSET =
	/^\/_app\/immutable\/assets\/(graphite|source-sans-3-latin-wght-normal)\.[\w-]+\.(css|woff2)$/;

interface DesignWindow {
	__pcDesign?: (design: Design) => void;
}

/** This device's saved design; today's when nothing (or nothing valid) is saved. */
export function savedDesign(): Design {
	try {
		return localStorage.getItem(DESIGN_KEY) === 'graphite' ? 'graphite' : 'current';
	} catch {
		return 'current';
	}
}

/** Save a design for this device and show it now. */
export function setDesign(design: Design): void {
	try {
		localStorage.setItem(DESIGN_KEY, design);
	} catch {
		// Private mode / storage disabled: it applies to this page only.
	}
	(globalThis as DesignWindow).__pcDesign?.(design);
}
