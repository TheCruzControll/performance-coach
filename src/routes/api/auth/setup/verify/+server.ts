import { json } from '@sveltejs/kit';
import {
	authErrorResponse,
	authRequest,
	completeSetup,
	NO_STORE,
	readJsonBody,
	readSessionToken,
	setSessionCookie
} from '#lib/server/auth/index.ts';
import type { RequestHandler } from './$types';

/**
 * First-run setup, step 2: verify the first passkey, create the owner, close setup for good and
 * return the 10 recovery codes — this response is the only time they exist in plain text.
 */
export const POST: RequestHandler = async (event) => {
	try {
		const body = (await readJsonBody(event.request)) as { token?: unknown; response?: unknown };
		const result = await completeSetup(
			{ token: body?.token, response: body?.response },
			readSessionToken(event.cookies, event.url),
			authRequest(event, { webauthn: true })
		);
		setSessionCookie(event.cookies, event.url, result);
		return json({ ok: true, recoveryCodes: result.recoveryCodes }, { headers: NO_STORE });
	} catch (error) {
		return authErrorResponse(error);
	}
};
