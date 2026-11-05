import { error, json } from '@sveltejs/kit';
import {
	authErrorResponse,
	authRequest,
	beginPasskeyRegistration,
	NO_STORE
} from '#lib/server/auth/index.ts';
import type { RequestHandler } from './$types';

/** Add a passkey, step 1 (signed in, or a recovery session replacing a lost passkey). */
export const POST: RequestHandler = async (event) => {
	const session = event.locals.session;
	if (!session) error(401, 'Sign in to continue.'); // the guard already enforces this
	try {
		const options = await beginPasskeyRegistration(session, authRequest(event, { webauthn: true }));
		return json(options, { headers: NO_STORE });
	} catch (err) {
		return authErrorResponse(err);
	}
};
