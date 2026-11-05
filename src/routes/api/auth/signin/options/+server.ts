import { json } from '@sveltejs/kit';
import { authErrorResponse, authRequest, beginSignIn, NO_STORE } from '#lib/server/auth/index.ts';
import type { RequestHandler } from './$types';

/** Passkey sign-in, step 1: assertion options with a fresh single-use challenge. */
export const POST: RequestHandler = async (event) => {
	try {
		const options = await beginSignIn(authRequest(event, { webauthn: true }));
		return json(options, { headers: NO_STORE });
	} catch (error) {
		return authErrorResponse(error);
	}
};
