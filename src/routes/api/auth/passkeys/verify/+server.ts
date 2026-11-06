import { error, json } from '@sveltejs/kit';
import {
	authErrorResponse,
	authRequest,
	completePasskeyRegistration,
	NO_STORE,
	readJsonBody,
	setSessionCookie
} from '#lib/server/auth/index.ts';
import type { RequestHandler } from './$types';

/**
 * Add a passkey, step 2. After a recovery sign-in this also rotates the restricted recovery
 * session into a full session (new cookie).
 */
export const POST: RequestHandler = async (event) => {
	const session = event.locals.session;
	if (!session) error(401, 'Sign in to continue.'); // the guard already enforces this
	try {
		const body = (await readJsonBody(event.request)) as { response?: unknown };
		const result = await completePasskeyRegistration(
			session,
			body?.response,
			authRequest(event, { webauthn: true })
		);
		if (result.upgradedSession) {
			setSessionCookie(event.cookies, event.url, result.upgradedSession);
		}
		return json(
			{ ok: true, passkey: result.passkey, recovered: Boolean(result.upgradedSession) },
			{ headers: NO_STORE }
		);
	} catch (err) {
		return authErrorResponse(err);
	}
};
