import { error, json } from '@sveltejs/kit';
import { authRequest, setSessionCookie } from '#lib/server/auth/index.ts';
import { mintTestSession } from '#lib/server/auth/test-support.ts';
import { testRoutesEnabled } from '#lib/server/env.ts';
import type { RequestHandler } from './$types';

/**
 * TEST ONLY: mint an owner session without a passkey, for WebKit e2e (no virtual authenticator
 * there). 404 unless ENABLE_TEST_ROUTES is on *and* allowed here (local development and tests,
 * never a hosted deployment; env validation refuses to start otherwise). Chromium e2e performs
 * real WebAuthn ceremonies instead.
 */
export const POST: RequestHandler = async (event) => {
	if (!testRoutesEnabled()) error(404, 'Not found');
	try {
		const issued = await mintTestSession(authRequest(event));
		setSessionCookie(event.cookies, event.url, issued);
		return json({ ok: true, sessionId: issued.session.id });
	} catch {
		error(404, 'Not found');
	}
};
