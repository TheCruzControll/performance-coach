/**
 * Actions with account-wide effects, run last and alone (project `exclusive`): signing out every
 * other session would end the sessions parallel specs use, and the last-passkey rule needs the
 * account down to one passkey. Real WebAuthn ceremonies (Chromium virtual authenticator).
 */
import { createHash } from 'node:crypto';
import { expect, test, type Browser } from '@playwright/test';
import { captureScreen, ORIGIN, query, toastWith } from './support';
import { addVirtualAuthenticator, chromiumOnly } from './webauthn';

test.skip(...chromiumOnly);

// Every spec registers its passkeys from the one shared owner session, so its `register` rate
// limit (src/lib/server/auth/policy.ts) is mostly spent by the time these run, and a retry would
// exceed it. These account-wide specs start from a fresh budget, every attempt.
test.beforeEach(async () => {
	await query(`delete from auth_rate_limits where key like 'register:%'`);
});

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Another device: registers its own passkey, forgets the shared session, signs in with it. */
async function otherDevice(browser: Browser) {
	const context = await browser.newContext();
	const page = await context.newPage();
	const authenticator = await addVirtualAuthenticator(page);
	await page.goto('/profile/security');
	await page.getByTestId('add-passkey').click();
	await expect(toastWith(page, /Passkey added: /)).toBeVisible();
	await context.clearCookies();
	// Conditional UI (autofill) signs in on its own with the virtual authenticator.
	await page.goto('/');
	await expect(page).toHaveURL(/\/today$/);
	const cookie = (await context.cookies(ORIGIN)).find((c) => /session$/.test(c.name))!;
	const [row] = await query<{ id: string }>('select id from auth_sessions where token_hash = $1', [
		sha256(cookie.value)
	]);
	return { context, page, authenticator, sessionId: row!.id };
}

test('sign out everywhere else ends every other session, not this one', async ({
	page,
	browser
}, testInfo) => {
	const phone = await otherDevice(browser);
	const laptop = await otherDevice(browser);

	await page.goto('/profile/security');
	const rows = page.getByTestId('session-row');
	expect(await rows.count()).toBeGreaterThanOrEqual(3);
	await page.getByTestId('revoke-others').click();
	await expect(toastWith(page, /Signed out \d+ other devices?/)).toBeVisible();
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toHaveAttribute('data-current', 'true');
	await expect(page.getByTestId('revoke-others')).toHaveCount(0);
	await captureScreen(page, testInfo, 'security-signed-out-elsewhere');

	for (const device of [phone, laptop]) {
		// Its passkey would sign it straight back in: the virtual authenticator answers the sign-in
		// screen's autofill request at once, which can take the device back to /today before the
		// URL below is ever sampled. A signed-out device stays signed out without it.
		await device.authenticator.remove();
		await device.page.goto('/today');
		await expect(device.page).toHaveURL(/\/\?next=%2Ftoday$/);
		await expect(device.page.getByTestId('signin-screen')).toBeVisible();
		expect(
			await query('select revoked_reason from auth_sessions where id = $1', [device.sessionId])
		).toEqual([{ revoked_reason: 'signed_out_elsewhere' }]);
		await device.context.close();
	}
	await page.goto('/today');
	await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
});

test('the last passkey can never be removed', async ({ page }, testInfo) => {
	await page.goto('/profile/security');
	const rows = page.getByTestId('passkey-row');
	// Remove passkeys until one is left (other specs added several).
	while ((await rows.count()) > 1) {
		const before = await rows.count();
		await rows.last().getByTestId('remove-passkey').click();
		await page.getByTestId('confirm-remove').click();
		await expect(rows).toHaveCount(before - 1);
	}
	const last = rows.first().getByTestId('remove-passkey');
	await expect(last).toBeDisabled();
	await expect(last).toHaveAccessibleName(/is your only passkey/);
	await expect(page.getByText('Your only passkey can’t be removed.')).toBeVisible();
	await captureScreen(page, testInfo, 'security-single-passkey');

	// The server refuses too, whatever the client does.
	const [remaining] = await query<{ id: string }>('select id from passkey_credentials');
	const res = await page.request.post('/profile/security?/remove', {
		headers: { origin: ORIGIN, accept: 'text/html' },
		form: { id: remaining!.id }
	});
	expect(res.status()).toBe(409);
	expect(await query('select count(*)::int as n from passkey_credentials')).toEqual([{ n: 1 }]);
});
