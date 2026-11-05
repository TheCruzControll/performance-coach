/**
 * Leaving a page must not surface as an error.
 *
 * Vite's dynamic-import helper loads a chunk's stylesheets first and, if one fails, dispatches a
 * cancelable `vite:preloadError` and then rejects the import ("Unable to preload CSS for …").
 * SvelteKit imports the root error page on every start, and that page renders the app shell, so
 * pages that do not (`/`, `/design`) fetch the shell's stylesheets at runtime. Leaving such a
 * page before they arrive cancels the loads; WebKit reports a cancelled stylesheet as a load
 * error, so the import rejected on the way out and was recorded as a client error (CI, WebKit).
 *
 * While the page is unloading the failure means nothing, so it is cancelled. Any other preload
 * failure keeps Vite's default: the import rejects and the app's error handling takes over.
 * SvelteKit already listens for `beforeunload`, so listening here costs no back/forward-cache
 * eligibility.
 */
const LEAVING_RESET_MS = 10_000;

let installed = false;
let leaving = false;
let reset: ReturnType<typeof setTimeout> | undefined;

function markLeaving(): void {
	leaving = true;
	clearTimeout(reset);
	// A navigation that never happens (cancelled, a download) must not mute real failures for
	// the rest of the visit.
	reset = setTimeout(() => (leaving = false), LEAVING_RESET_MS);
}

export function ignorePreloadErrorsWhileLeaving(): void {
	if (installed || typeof window === 'undefined') return;
	installed = true;
	addEventListener('beforeunload', markLeaving);
	addEventListener('pagehide', markLeaving);
	addEventListener('pageshow', () => {
		leaving = false; // restored from the back/forward cache
		clearTimeout(reset);
	});
	addEventListener('vite:preloadError', (event) => {
		if (leaving) event.preventDefault();
	});
}
