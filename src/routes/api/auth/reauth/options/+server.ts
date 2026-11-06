import { error, json } from '@sveltejs/kit';
import {
	authErrorResponse,
	authRequest,
	beginReauthentication,
	NO_STORE
} from '#lib/server/auth/index.ts';
import type { RequestHandler } from './$types';

/** Step-up, step 1: assertion options for one of the owner's passkeys, bound to this session. */
export const POST: RequestHandler = async (event) => {
	const session = event.locals.session;
	if (!session) error(401, 'Sign in to continue.'); // the guard already enforces this
	try {
		const options = await beginReauthentication(session, authRequest(event, { webauthn: true }));
		return json(options, { headers: NO_STORE });
	} catch (err) {
		return authErrorResponse(err);
	}
};
