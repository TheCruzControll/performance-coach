/**
 * Is the page being left?
 *
 * Leaving a page cancels whatever it still had in flight: the stylesheets and code chunks it
 * loads while starting up (SvelteKit imports the root layout and error page on every start, and
 * stylesheets small enough to be inlined into the HTML are fetched again by those imports), the
 * service-worker registration it starts on `load`, data requests. Browsers report those
 * cancellations as failures, WebKit loudly: "Unable to preload CSS for …", "Script
 * …/service-worker.js load failed", and the errors SvelteKit then hits on the way out. They
 * happen on a page nobody can see any more, so they are not errors: the reporters in
 * `errors.ts` and `hooks.client.ts` stay silent while `isLeaving()` is true.
 *
 * Leaving starts at `beforeunload` (SvelteKit already listens for it, so this costs no
 * back/forward-cache eligibility) or `pagehide`. It ends when the page is restored from the
 * back/forward cache, or after LEAVING_RESET_MS if the navigation never happened (cancelled, a
 * download), so real failures are not muted for the rest of the visit.
 */
export const LEAVING_RESET_MS = 10_000;

let installed = false;
let leaving = false;
let reset: ReturnType<typeof setTimeout> | undefined;

function markLeaving(): void {
	leaving = true;
	clearTimeout(reset);
	reset = setTimeout(() => (leaving = false), LEAVING_RESET_MS);
}

/** Start tracking (once, from the client `init` hook, before anything is loaded). */
export function trackLeaving(): void {
	if (installed || typeof window === 'undefined') return;
	installed = true;
	addEventListener('beforeunload', markLeaving);
	addEventListener('pagehide', markLeaving);
	addEventListener('pageshow', (event) => {
		// Only a restore from the back/forward cache: the first `pageshow` of a page can arrive
		// after a navigation away has already started.
		if (!event.persisted) return;
		leaving = false;
		clearTimeout(reset);
	});
}

export function isLeaving(): boolean {
	return leaving;
}
