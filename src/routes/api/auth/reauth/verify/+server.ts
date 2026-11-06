import { error, json } from '@sveltejs/kit';
import {
	authErrorResponse,
	authRequest,
	completeReauthentication,
	NO_STORE,
	readJsonBody
} from '#lib/server/auth/index.ts';
import type { RequestHandler } from './$types';

/** Step-up, step 2: verify the assertion; sensitive Security actions are allowed for a while. */
export const POST: RequestHandler = async (event) => {
	const session = event.locals.session;
	if (!session) error(401, 'Sign in to continue.'); // the guard already enforces this
	try {
		const body = (await readJsonBody(event.request)) as { response?: unknown };
		await completeReauthentication(session, body?.response, authRequest(event, { webauthn: true }));
		return json({ ok: true }, { headers: NO_STORE });
	} catch (err) {
		return authErrorResponse(err);
	}
};
