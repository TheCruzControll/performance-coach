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
 * back/forward-cache eligibility) or `pagehide`, noted from the page's first moment by the head
 * script in src/app.html. A navigation away can start before the app's code has loaded; the page
 * then goes on starting while the next one loads, and its startup loads fail on the way out. A
 * listener added when the app starts would have missed that `beforeunload`, and WebKit fires no
 * `pagehide` for a page whose `load` event has not fired yet, so nothing else would mark the page
 * as left. Leaving ends when the page is restored from the back/forward cache, or
 * LEAVING_RESET_MS after it started if the navigation never happened (cancelled, a download), so
 * real failures are not muted for the rest of the visit.
 */
export const LEAVING_RESET_MS = 10_000;

/** When the page last started being left (`Date.now()`), set by src/app.html. */
interface LeavingWindow {
	__pcLeftAt?: number;
}

export function isLeaving(): boolean {
	if (typeof window === 'undefined') return false;
	const leftAt = (window as LeavingWindow).__pcLeftAt;
	return leftAt !== undefined && Date.now() - leftAt < LEAVING_RESET_MS;
}
