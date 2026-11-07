import { error, json } from '@sveltejs/kit';
import { emailLinkConfigured } from '#lib/server/auth/email-link-config.ts';
import { testRoutesEnabled } from '#lib/server/env.ts';
import { testOutbox } from '#lib/server/mail/index.ts';
import type { RequestHandler } from './$types';

/** 404 unless the email link is on with the recording test provider (never real mail). */
function requireTestProvider(): void {
	const config = emailLinkConfigured();
	if (!config.enabled || config.provider !== 'test') error(404, 'Not found');
}

/**
 * TEST ONLY: the test mail outbox (src/lib/server/mail/test-outbox.ts), so e2e can follow an
 * emailed sign-in link. 404 unless ENABLE_TEST_ROUTES is on *and* allowed here (never a hosted
 * deployment; the post-deploy smoke check proves it in production) and the test provider is
 * active. GET lists the messages, newest first; DELETE clears them.
 */
export const GET: RequestHandler = () => {
	if (!testRoutesEnabled()) error(404, 'Not found');
	requireTestProvider();
	const messages = testOutbox
		.list()
		.map(({ to, from, subject, text, sentAt }) => ({ to, from, subject, text, sentAt }));
	return json({ messages }, { headers: { 'cache-control': 'no-store' } });
};

export const DELETE: RequestHandler = () => {
	if (!testRoutesEnabled()) error(404, 'Not found');
	requireTestProvider();
	testOutbox.clear();
	return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
};
