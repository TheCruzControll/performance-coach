import { json } from '@sveltejs/kit';
import {
	authErrorResponse,
	authRequest,
	beginSetup,
	NO_STORE,
	readJsonBody
} from '#lib/server/auth/index.ts';
import type { RequestHandler } from './$types';

/** First-run setup, step 1: registration options for the owner's first passkey. */
export const POST: RequestHandler = async (event) => {
	try {
		const body = (await readJsonBody(event.request)) as { token?: unknown; name?: unknown };
		const options = await beginSetup(
			{ token: body?.token, name: body?.name },
			authRequest(event, { webauthn: true })
		);
		return json(options, { headers: NO_STORE });
	} catch (error) {
		return authErrorResponse(error);
	}
};
