import { json } from '@sveltejs/kit';
import { emailLinkConfigured } from '#lib/server/auth/email-link-config.ts';
import {
	AuthError,
	authErrorResponse,
	authRequest,
	completeEmailSignIn,
	DEFAULT_RETURN_PATH,
	NO_STORE,
	readJsonBody,
	readSessionToken,
	relyingParty,
	setSessionCookie
} from '#lib/server/auth/index.ts';
import type { RequestHandler } from './$types';

/** `{"token":"<43 characters>"}` is about 55 bytes: anything near this cap is not a link. */
const MAX_BODY_BYTES = 1024;

/**
 * Redeem an email sign-in link (ADR 0011): the token from the link's fragment, posted when the
 * owner taps Sign in. Rotates the presented session, sets the new session cookie and says where
 * to go (Today). Every bad link is the same 401 `link_invalid`.
 *
 * POST only: a mail scanner's or a browser's prefetch GET gets 405 and spends nothing. 404 while
 * the feature is off or the relying party does not resolve for this origin.
 */
export const POST: RequestHandler = async (event) => {
	if (!emailLinkConfigured().enabled || !relyingParty(event.url).ok) {
		return authErrorResponse(new AuthError('not_found', 'Not found.'));
	}
	try {
		const body = (await readJsonBody(event.request, MAX_BODY_BYTES)) as { token?: unknown } | null;
		const issued = await completeEmailSignIn(
			body?.token,
			readSessionToken(event.cookies, event.url),
			authRequest(event, { webauthn: true })
		);
		setSessionCookie(event.cookies, event.url, issued);
		return json({ ok: true, redirectTo: DEFAULT_RETURN_PATH }, { headers: NO_STORE });
	} catch (error) {
		return authErrorResponse(error);
	}
};
