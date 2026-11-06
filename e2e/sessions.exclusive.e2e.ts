/**
 * Actions with account-wide effects, run last and alone (project `exclusive`): signing out every
 * other session would end the sessions parallel specs use, and the last-passkey rule needs the
 * account down to one passkey. Real WebAuthn ceremonies (Chromium virtual authenticator); each
 * test signs in for itself, so its session is fresh and needs no step-up prompt.
 */
import { expect, test, type Browser, type TestInfo } from '@playwright/test';
import { captureScreen, ORIGIN, query, toastWith } from './support';
import { chromiumOnly, signInAsOwner } from './webauthn';

test.skip(...chromiumOnly);

/** Another device, signed in with a passkey ceremony of its own. */
async function otherDevice(browser: Browser, testInfo: TestInfo) {
	const context = await browser.newContext();
	const sessionId = await signInAsOwner(context, testInfo);
	return { context, page: await context.newPage(), sessionId };
}

test('sign out everywhere else ends every other session, not this one', async ({
	page,
	context,
	browser
}, testInfo) => {
	const phone = await otherDevice(browser, testInfo);
	const laptop = await otherDevice(browser, testInfo);

	await signInAsOwner(context, testInfo);
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
		// No authenticator on this page (signInAsOwner signed in on a page of its own), so the
		// sign-in screen's autofill request cannot sign it straight back in.
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

test('the last passkey can never be removed', async ({ page, context }, testInfo) => {
	await signInAsOwner(context, testInfo);
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
