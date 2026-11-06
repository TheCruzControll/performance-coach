/**
 * Step-up re-authentication (docs/security.md): a session that has not used a passkey for
 * 5 minutes — a copied cookie, say — cannot add or remove passkeys, create recovery codes or
 * sign devices out until the owner confirms with one of their passkeys. The server refuses; the
 * Security screen asks, then retries the action. Chromium runs the real assertion (virtual
 * authenticator); WebKit has none, so there it proves the prompt.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
	captureScreen,
	ORIGIN,
	query,
	SAME_ORIGIN,
	toastWith,
	trackConsoleErrors
} from './support';
import {
	addVirtualAuthenticator,
	signInAsOwner,
	skipUnlessChromium,
	toBase64Url
} from './webauthn';

async function audit(page: Page, label: string) {
	for (const theme of ['dark', 'light'] as const) {
		await page.evaluate((t) => {
			if (t === 'dark') delete document.documentElement.dataset.theme;
			else document.documentElement.dataset.theme = t;
		}, theme);
		await page.waitForTimeout(250);
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		expect(
			violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`)),
			`${label} (${theme})`
		).toEqual([]);
	}
	await page.evaluate(() => delete document.documentElement.dataset.theme);
}

const passkeyStored = async (id: string) =>
	(await query('select 1 from passkey_credentials where id = $1', [id])).length === 1;

test('a stale session must confirm with a passkey before removing one, then it goes through', async ({
	page,
	context,
	browserName
}, testInfo) => {
	skipUnlessChromium(testInfo, browserName);
	const errors = trackConsoleErrors(page);
	const sessionId = await signInAsOwner(context, testInfo);
	const authenticator = await addVirtualAuthenticator(page);
	await page.goto('/profile/security');
	// Hydrated first: a tap on the server-rendered button before then does nothing.
	await page.waitForLoadState('networkidle');
	await page.getByTestId('add-passkey').click();
	await expect(toastWith(page, /Passkey added: /)).toBeVisible();
	const passkeyId = toBase64Url((await authenticator.credentials())[0]!.credentialId);
	const row = page.locator(`[data-passkey-id="${passkeyId}"]`);
	await expect(row).toBeVisible();

	// As if this cookie had been copied: its last passkey use is more than 5 minutes old.
	await query(
		`update auth_sessions set reauthenticated_at = now() - interval '6 minutes' where id = $1`,
		[sessionId]
	);

	// The server is the boundary, whatever the client does.
	const direct = await page.request.post('/profile/security?/remove', {
		headers: { origin: ORIGIN, accept: 'text/html' },
		form: { id: passkeyId }
	});
	expect(direct.status()).toBe(403);
	expect(await passkeyStored(passkeyId)).toBe(true);

	// The screen asks for a passkey over the sheet that was refused.
	await row.getByTestId('remove-passkey').click();
	await page.getByTestId('confirm-remove').click();
	const sheet = page.getByTestId('reauth-sheet');
	await expect(sheet).toBeVisible();
	await expect(sheet.getByRole('heading', { name: 'Confirm it’s you' })).toBeVisible();
	await captureScreen(page, testInfo, 'security-reauth');
	await audit(page, 'step-up prompt');

	// Face ID fails: a designed error, and nothing was removed.
	await authenticator.setUserVerified(false);
	await sheet.getByTestId('reauth-continue').click();
	await expect(sheet.getByTestId('reauth-error')).toContainText('Nothing was changed');
	await captureScreen(page, testInfo, 'security-reauth-error');
	await audit(page, 'step-up error');
	expect(await passkeyStored(passkeyId)).toBe(true);

	// Face ID works: the check passes and the removal goes through without another tap.
	await authenticator.setUserVerified(true);
	await sheet.getByTestId('reauth-continue').click();
	await expect(toastWith(page, 'Passkey removed')).toBeVisible();
	await expect(sheet).toBeHidden();
	await expect(toastWith(page, 'Nothing was changed')).toHaveCount(0);
	await expect(row).toHaveCount(0);
	expect(await passkeyStored(passkeyId)).toBe(false);
	expect(
		await query(
			`select reauthenticated_at > now() - interval '1 minute' as fresh from auth_sessions where id = $1`,
			[sessionId]
		)
	).toEqual([{ fresh: true }]);
	// The refusals above are expected responses, not errors.
	expect(errors.filter((e) => !/\b40[13]\b/.test(e))).toEqual([]);
});

test('without a passkey check, signing out a device shows the prompt and changes nothing', async ({
	page,
	playwright,
	browserName
}, testInfo) => {
	testInfo.skip(
		browserName !== 'webkit',
		'Chromium completes the passkey check above; WebKit has no virtual authenticator, so it proves the prompt'
	);
	// WebKit's session came from the test-only route: it has never used a passkey. Another
	// device to sign out, minted the same way for this test alone.
	const api = await playwright.request.newContext({
		baseURL: ORIGIN,
		extraHTTPHeaders: SAME_ORIGIN
	});
	const { sessionId } = (await (await api.post('/api/test-support/session')).json()) as {
		sessionId: string;
	};
	await api.dispose();

	await page.goto('/profile/security');
	// Hydrated first: before then the form would post without the screen's handling.
	await page.waitForLoadState('networkidle');
	const row = page.locator(`[data-session-id="${sessionId}"]`);
	await row.getByTestId('revoke-session').click();
	const sheet = page.getByTestId('reauth-sheet');
	await expect(sheet).toBeVisible();
	await expect(sheet.getByTestId('reauth-continue')).toBeVisible();
	await captureScreen(page, testInfo, 'security-reauth');
	await audit(page, 'step-up prompt');

	await sheet.getByRole('button', { name: 'Cancel' }).click();
	await expect(sheet).toBeHidden();
	await expect(toastWith(page, 'Nothing was changed')).toBeVisible();
	await expect(row).toBeVisible();
	expect(await query('select revoked_at from auth_sessions where id = $1', [sessionId])).toEqual([
		{ revoked_at: null }
	]);
});
