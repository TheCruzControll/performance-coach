/**
 * The read-only smoke a deployment gets (and every local run): the server and its database are up,
 * and a signed-out visitor meets the sign-in screen, never an app page.
 */
import { expect, signedOut, test } from './support';

test.use({ storageState: signedOut });

test('health: the server answers with its version and a live database, never cached', async ({
	request
}) => {
	const res = await request.get('/api/health');
	expect(res.status()).toBe(200);
	expect(res.headers()['cache-control']).toBe('no-store');
	expect(await res.json()).toMatchObject({ ok: true, db: 'up', version: expect.any(String) });
});

test('signed out: an app page sends the visitor to sign-in, which renders', async ({ page }) => {
	await page.goto('/today');
	await expect(page).toHaveURL(/\/\?next=%2Ftoday$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Train with intent.' })).toBeVisible();
	await expect(page.getByTestId('passkey-signin')).toBeVisible();
});
