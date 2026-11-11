/**
 * Launching into the workout in progress without the network (docs/performance.md, app launch).
 * The start URL (/today) is server-rendered: offline, the service worker answers it with the
 * prerendered /offline screen, a dead end mid-workout. So the store keeps a small flag in
 * localStorage while a workout is in progress on this device (active-flag.ts), and LAUNCH_SCRIPT,
 * inline in the prerendered /offline page's head (routes/(app)/offline/LaunchRedirect.svelte),
 * sends a launch that lands there straight to that kind's workout page, before the app boots. The
 * service worker gives the start URL less time when a workout is in progress (navigationTimeout),
 * so lie-fi reaches the workout sooner too.
 *
 * No imports: vite.config.ts imports LAUNCH_SCRIPT to allow it by its CSP hash, the service worker
 * imports navigationTimeout, and the /offline page's client build carries none of it.
 */

/** active-flag.ts's ACTIVE_WORKOUT_KEY, by value (launch.test.ts checks). */
const ACTIVE_WORKOUT_KEY = 'pc:active-workout:v1';

/** The manifest's start_url (static/manifest.webmanifest): where an installed app launches. */
export const START_URL = '/today';

/**
 * Where the offline screen lists today's sessions saved on this device (routes/OfflineToday.svelte,
 * today-kits.ts), so a launch with no workout in progress can still start one: the start URL and
 * /offline itself, the pages LAUNCH_SCRIPT also acts on. Any other screen the offline screen is
 * served at (a reload of Progress) keeps to its own state.
 */
export const listsToday = (pathname: string) => pathname === START_URL || pathname === '/offline';

/** Each kind's workout page, as kinds.ts WORKOUT_PATHS has them (launch.test.ts checks). */
export const LAUNCH_PATHS = {
	strength: '/workout',
	run: '/workout/run',
	other: '/workout/session'
} as const;

/** A connected-but-dead network ("lie-fi") can hang a request for a minute; give up sooner. */
export const NAVIGATION_TIMEOUT_MS = 6000;

/**
 * The start URL's, with a workout in progress: the precached workout page beats a slow server.
 * Production's cold start answers in about 2.4-2.9 s, so a launch then lands on the workout,
 * which is where the owner is mid-workout anyway.
 */
export const ACTIVE_LAUNCH_TIMEOUT_MS = 2000;

/**
 * How long the service worker waits for a navigation's network answer before the offline screen.
 * `active` is asked only for the start URL: whether a workout is in progress on this device.
 */
export async function navigationTimeout(
	pathname: string,
	active: () => Promise<boolean>
): Promise<number> {
	if (pathname !== START_URL) return NAVIGATION_TIMEOUT_MS;
	try {
		return (await active()) ? ACTIVE_LAUNCH_TIMEOUT_MS : NAVIGATION_TIMEOUT_MS;
	} catch {
		return NAVIGATION_TIMEOUT_MS;
	}
}

/**
 * The inline script (LaunchRedirect.svelte puts it in the prerendered /offline page's head): on
 * the start URL or /offline itself, with a valid flag, it replaces the page with the flagged
 * kind's workout page (precached and prerendered, so it opens offline), as the parser reaches it,
 * before the app boots or the offline screen paints. Any other URL the offline screen is served at
 * (a reload of Progress) keeps it. Anything malformed does nothing. ES2017, no modules.
 */
export const LAUNCH_SCRIPT = `(function () {
	try {
		var p = location.pathname;
		if (p !== '${START_URL}' && p !== '/offline') return;
		var s = JSON.parse(localStorage.getItem('${ACTIVE_WORKOUT_KEY}'));
		if (!s || s.v !== 1 || typeof s.workoutId != 'string') return;
		var to = ${JSON.stringify(LAUNCH_PATHS)};
		if (Object.prototype.hasOwnProperty.call(to, s.kind)) location.replace(to[s.kind]);
	} catch (e) {}
})();`;
