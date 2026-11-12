/**
 * WebKit has no WebAuthn virtual authenticator, so its specs run on a session minted by the
 * test-only route (POST /api/test-support/session: exists only with ENABLE_TEST_ROUTES, which
 * env validation refuses on any hosted deployment). The owner was created by the real setup in
 * auth.setup.ts; passkey ceremonies themselves are covered on Chromium.
 *
 * With more than one owner world (a serial CI leg, e2e/worlds.ts), the session is minted in the
 * world the owner setup ran in, whichever this worker serves: setup-worlds then copies it, with
 * the owner, into every other world. Cookies name no port, so the one state signs in everywhere.
 */
import { expect, test as setup } from '@playwright/test';
import { ownerWorld } from './world-copy';

setup('WebKit: mint an owner session through the test-only route', async ({ request }) => {
	const { origin } = await ownerWorld(process.env);
	const url = new URL('/api/test-support/session', origin).href;
	const res = await request.post(url, { headers: { origin } });
	expect(res.status()).toBe(200);
	await request.storageState({ path: 'e2e/.auth/webkit.json' });
});
