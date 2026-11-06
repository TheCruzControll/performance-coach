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
 * `errors.ts` and `hooks.client.ts` stay silent while `isLeaving()` is true, and a navigation
 * whose data request the leave cancels waits in `hooks.client.ts` for `whenLeaveEnds()`.
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

/** How long the current leave has left (ms), or 0 when the page is not being left. */
function leaveRemaining(): number {
	if (typeof window === 'undefined') return 0;
	const leftAt = (window as LeavingWindow).__pcLeftAt;
	return leftAt === undefined ? 0 : Math.max(0, LEAVING_RESET_MS - (Date.now() - leftAt));
}

export function isLeaving(): boolean {
	return leaveRemaining() > 0;
}

/**
 * Resolves once the page is no longer being left: at once when it is not, on a restore from the
 * back/forward cache, or when the leave expires (a new leave meanwhile starts the wait again). A
 * page that really is left never sees it resolve: its document is gone first. Anything that waits
 * for it does nothing on the way out, not even a request: WebKit refuses every load a page starts
 * once the next page is loading, and logs each refusal as an error.
 */
export function whenLeaveEnds(): Promise<void> {
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const check = () => {
			clearTimeout(timer);
			const remaining = leaveRemaining();
			if (remaining > 0) {
				timer = setTimeout(check, remaining);
				return;
			}
			removeEventListener('pageshow', check);
			resolve();
		};
		// After the head script's own `pageshow` listener, which ends the leave on a restore.
		addEventListener('pageshow', check);
		check();
	});
}
