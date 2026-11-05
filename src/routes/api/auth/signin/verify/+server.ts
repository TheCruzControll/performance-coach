import { json } from '@sveltejs/kit';
import {
	authErrorResponse,
	authRequest,
	completeSignIn,
	NO_STORE,
	readJsonBody,
	readSessionToken,
	safeReturnPath,
	setSessionCookie
} from '#lib/server/auth/index.ts';
import type { RequestHandler } from './$types';

/**
 * Passkey sign-in, step 2: verify the assertion, rotate the session (the cookie the device
 * presented is revoked, a new one issued) and say where to go next (a safe same-origin path).
 */
export const POST: RequestHandler = async (event) => {
	try {
		const body = (await readJsonBody(event.request)) as { response?: unknown; next?: unknown };
		const issued = await completeSignIn(
			body?.response,
			readSessionToken(event.cookies, event.url),
			authRequest(event, { webauthn: true })
		);
		setSessionCookie(event.cookies, event.url, issued);
		const next = typeof body?.next === 'string' ? body.next : null;
		return json({ ok: true, redirectTo: safeReturnPath(next) }, { headers: NO_STORE });
	} catch (error) {
		return authErrorResponse(error);
	}
};
