import { json, redirect } from '@sveltejs/kit';
import {
	authErrorResponse,
	authRequest,
	clearSessionCookie,
	readSessionToken,
	signOut
} from '#lib/server/auth/index.ts';
import type { RequestHandler } from './$types';

/**
 * Sign out: revoke this device's session and delete its cookie. Public on purpose (an expired
 * session must still be able to clear the device). The browser then clears its own account
 * data (src/lib/client/signout.ts: Cache Storage except the app shell, IndexedDB, session
 * storage). Before posting, the screen flushes unsynced workout changes for at most 5 s and asks
 * before signing out deletes what is left; after clearing, it leaves a one-shot marker for the
 * sign-in screen. A signed-out URL without the marker (this endpoint's 303, a typed URL) keeps
 * only unsynced workout changes until the owner deletes them or signs in.
 *
 * `Clear-Site-Data: "cache"` drops HTTP-cached responses and back/forward-cache pages that may
 * show account data. Deliberately *not* "storage" (it would also wipe device preferences such
 * as the theme and unregister the offline app shell) nor "cookies" (it applies to the whole
 * registrable domain, nikocruz.com, not just this app). See docs/security.md.
 */
export const POST: RequestHandler = async (event) => {
	try {
		await signOut(readSessionToken(event.cookies, event.url), authRequest(event));
	} catch (error) {
		return authErrorResponse(error);
	}
	clearSessionCookie(event.cookies, event.url);
	event.setHeaders({ 'clear-site-data': '"cache"', 'cache-control': 'no-store' });
	// A plain HTML form post (no JavaScript) lands back on the sign-in screen.
	if (!(event.request.headers.get('accept') ?? '').includes('application/json')) {
		redirect(303, '/?signedOut=1');
	}
	return json({ ok: true });
};
