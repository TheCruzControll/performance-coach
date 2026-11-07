import { json } from '@sveltejs/kit';
import { waitUntil } from '@vercel/functions';
import { emailLinkConfigured } from '#lib/server/auth/email-link-config.ts';
import {
	AuthError,
	authErrorResponse,
	authRequest,
	NO_STORE,
	relyingParty,
	requestSignInLink
} from '#lib/server/auth/index.ts';
import { logger } from '#lib/server/observability/logger.ts';
import type { RequestHandler } from './$types';

/**
 * Email me a sign-in link (ADR 0011). The request carries no address and the body is never
 * read: the link only ever goes to OWNER_EMAIL.
 *
 * It answers 202 at once, before any database work, in every case (a link sent, a limit hit, no
 * owner, a provider failing), so status, body, headers, Server-Timing and timing cannot tell
 * them apart. The work runs after the response: on Vercel `waitUntil` keeps the instance alive
 * for it; elsewhere the promise simply runs. 404 while the feature is off or the relying party
 * does not resolve for this origin.
 */
export const POST: RequestHandler = (event) => {
	const config = emailLinkConfigured();
	if (!config.enabled || !relyingParty(event.url).ok) {
		return authErrorResponse(new AuthError('not_found', 'Not found.'));
	}
	const request = authRequest(event, { webauthn: true });
	waitUntil(
		requestSignInLink(request, { config }).catch((err: unknown) => {
			logger.error('email sign-in link: deferred request failed', { err });
		})
	);
	return json({ ok: true }, { status: 202, headers: NO_STORE });
};
