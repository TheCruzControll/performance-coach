/**
 * WebKit has no WebAuthn virtual authenticator, so its specs run on a session minted by the
 * test-only route (POST /api/test-support/session: exists only with ENABLE_TEST_ROUTES, which
 * env validation refuses on any hosted deployment). The owner was created by the real setup in
 * auth.setup.ts; passkey ceremonies themselves are covered on Chromium.
 */
import { expect, test as setup } from '@playwright/test';
import { SAME_ORIGIN } from './support';

setup('WebKit: mint an owner session through the test-only route', async ({ request }) => {
	const res = await request.post('/api/test-support/session', { headers: SAME_ORIGIN });
	expect(res.status()).toBe(200);
	await request.storageState({ path: 'e2e/.auth/webkit.json' });
});
