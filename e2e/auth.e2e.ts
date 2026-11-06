/**
 * Passkey authentication, end to end, with REAL WebAuthn ceremonies (Chromium's CDP virtual
 * authenticator; no auth bypass): sign-in, adding/renaming/removing passkeys, recovery-code
 * sign-in that forces a new passkey, session management and sign-out.
 *
 * Every test works on passkeys and sessions of its own (created through the real flows from the
 * shared signed-in state), so tests stay independent and never revoke the shared session.
 * "Sign out everywhere else" and "never the last passkey" change global state: they live in
 * sessions.exclusive.e2e.ts, which runs last.
 */
import { createHash } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
	captureScreen,
	ORIGIN,
	query,
	SAME_ORIGIN,
	signedOut,
	toastWith,
	trackConsoleErrors
} from './support';
import { addVirtualAuthenticator, chromiumOnly, type VirtualAuthenticator } from './webauthn';

test.skip(...chromiumOnly);

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const toBase64Url = (b64: string) => Buffer.from(b64, 'base64').toString('base64url');

async function sessionCookie(context: BrowserContext) {
	const cookies = await context.cookies(ORIGIN);
	return cookies.find((c) => c.name === 'session' || c.name === '__Host-session');
}

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

/**
 * From the shared signed-in state, register a passkey of this test's own (a real
 * registration ceremony from Profile → Security). Returns the authenticator holding it.
 */
async function addOwnPasskey(page: Page): Promise<VirtualAuthenticator & { passkeyId: string }> {
	const authenticator = await addVirtualAuthenticator(page);
	await page.goto('/profile/security');
	// Hydrated first: a tap on the server-rendered button before then does nothing.
	await page.waitForLoadState('networkidle');
	await page.getByTestId('add-passkey').click();
	await expect(toastWith(page, /Passkey added: /)).toBeVisible();
	const [credential] = await authenticator.credentials();
	expect(credential, 'the authenticator now holds a passkey').toBeTruthy();
	const passkeyId = toBase64Url(credential!.credentialId);
	await expect(page.locator(`[data-passkey-id="${passkeyId}"]`)).toBeVisible();
	return Object.assign(authenticator, { passkeyId });
}

/**
 * Browsers without conditional UI (passkeys offered in autofill): the button is the way in.
 * Where conditional UI exists, Chromium's virtual authenticator answers it at once, which
 * signs in without a tap; that path has its own test.
 */
async function withoutPasskeyAutofill(page: Page) {
	await page.addInitScript(() => {
		Object.defineProperty(PublicKeyCredential, 'isConditionalMediationAvailable', {
			value: async () => false
		});
	});
}

/** Sign in from the sign-in screen (button) with whatever passkey the page's authenticator holds. */
async function signInWithPasskey(page: Page) {
	await withoutPasskeyAutofill(page);
	await page.goto('/');
	await expect(page.getByTestId('signin-screen')).toBeVisible();
	await page.getByTestId('passkey-signin').click();
	await expect(page).toHaveURL(/\/today$/);
}

/** A device of its own: a new browser context that signs in with its own passkey. */
async function ownDevice(browser: Browser) {
	const context = await browser.newContext();
	const page = await context.newPage();
	const authenticator = await addOwnPasskey(page);
	await context.clearCookies(); // forget the shared session on this device only
	await signInWithPasskey(page);
	const cookie = (await sessionCookie(context))!;
	const [row] = await query<{ id: string }>('select id from auth_sessions where token_hash = $1', [
		sha256(cookie.value)
	]);
	return { context, page, authenticator, sessionId: row!.id };
}

test.describe('passkey authentication (real WebAuthn ceremonies)', () => {
	test('sign-in with a passkey returns to the page that asked for it', async ({
		page,
		context
	}, testInfo) => {
		await addOwnPasskey(page);
		await context.clearCookies();
		await withoutPasskeyAutofill(page);

		await page.goto('/profile');
		await expect(page).toHaveURL(/\/\?next=%2Fprofile$/);
		const errors = trackConsoleErrors(page);
		await expect(page.getByRole('heading', { level: 1, name: 'Train with intent.' })).toBeVisible();
		await page.evaluate(() => document.fonts.ready);
		await captureScreen(page, testInfo, 'sign-in');

		await page.getByTestId('passkey-signin').click();
		await expect(page).toHaveURL(/\/profile$/);
		await expect(page.getByTestId('owner-name')).toHaveText('Niko Cruz');

		// An opaque random token in an HttpOnly, SameSite=Lax, host-only cookie; only its hash is stored.
		const cookie = await sessionCookie(context);
		expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
		expect(cookie!.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(
			await query('select method, kind from auth_sessions where token_hash = $1', [
				sha256(cookie!.value)
			])
		).toEqual([{ method: 'passkey', kind: 'owner' }]);
		expect(
			await query('select 1 from auth_sessions where token_hash = $1', [cookie!.value])
		).toEqual([]);
		expect(errors).toEqual([]);
	});

	test('conditional UI: the passkey offered in autofill signs in without a tap', async ({
		page,
		context
	}) => {
		const errors = trackConsoleErrors(page);
		await addOwnPasskey(page);
		await context.clearCookies();
		const supported = await page.evaluate(() =>
			PublicKeyCredential.isConditionalMediationAvailable?.()
		);
		test.skip(!supported, 'this browser build has no conditional mediation');
		await page.goto('/?next=%2Fprogress');
		// The sign-in screen starts a conditional request; the authenticator answers it.
		await expect(page).toHaveURL(/\/progress$/);
		await expect(page.getByRole('heading', { level: 1, name: 'Progress' })).toBeVisible();
		const cookie = await sessionCookie(context);
		expect(
			await query('select method, kind from auth_sessions where token_hash = $1', [
				sha256(cookie!.value)
			])
		).toEqual([{ method: 'passkey', kind: 'owner' }]);
		expect(errors).toEqual([]);
	});

	test('a refused passkey shows a designed, accessible error', async ({
		page,
		context
	}, testInfo) => {
		const authenticator = await addOwnPasskey(page);
		await context.clearCookies();
		await withoutPasskeyAutofill(page);
		await authenticator.setUserVerified(false); // Face ID fails: user verification is required
		await page.goto('/');
		await page.getByTestId('passkey-signin').click();
		await expect(page.getByTestId('signin-error')).toBeVisible();
		await expect(page).toHaveURL(/\/$/);
		await captureScreen(page, testInfo, 'sign-in-error');
		await audit(page, 'sign-in error');

		// Face ID works again: the same screen signs in.
		await authenticator.setUserVerified(true);
		await page.getByTestId('passkey-signin').click();
		await expect(page).toHaveURL(/\/today$/);
	});

	test('add, rename and remove a passkey; a removed passkey no longer signs in', async ({
		page,
		context
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		const key = await addOwnPasskey(page);
		const row = page.locator(`[data-passkey-id="${key.passkeyId}"]`);
		await captureScreen(page, testInfo, 'security');

		await row.getByTestId('rename-passkey').click();
		const rename = page.getByTestId('rename-sheet');
		await expect(rename).toBeVisible();
		await rename.getByTestId('passkey-nickname').fill('  Gym locker   key ');
		await rename.getByTestId('save-nickname').click();
		await expect(toastWith(page, 'Passkey renamed')).toBeVisible();
		await expect(row.getByTestId('passkey-name')).toHaveText('Gym locker key');
		expect(
			await query('select nickname from passkey_credentials where id = $1', [key.passkeyId])
		).toEqual([{ nickname: 'Gym locker key' }]);

		await row.getByTestId('remove-passkey').click();
		const remove = page.getByTestId('remove-sheet');
		await expect(remove).toContainText('Remove Gym locker key?');
		await captureScreen(page, testInfo, 'security-remove-passkey');
		await remove.getByTestId('confirm-remove').click();
		await expect(toastWith(page, 'Passkey removed')).toBeVisible();
		await expect(row).toHaveCount(0);
		expect(await query('select 1 from passkey_credentials where id = $1', [key.passkeyId])).toEqual(
			[]
		);

		// The authenticator still holds it, but the server no longer accepts it.
		await context.clearCookies();
		await withoutPasskeyAutofill(page);
		await page.goto('/');
		await page.getByTestId('passkey-signin').click();
		await expect(page.getByTestId('signin-error')).toContainText('not registered');
		expect(errors.filter((e) => !/401/.test(e))).toEqual([]);
	});

	test('a recovery code burns, forces a new passkey, then works as a full session', async ({
		page,
		browser
	}, testInfo) => {
		// Fresh codes from Security (shown once), as the owner would after setup.
		await page.goto('/profile/security');
		await page.getByTestId('regenerate-codes').click();
		await page.getByTestId('confirm-regenerate').click();
		const sheet = page.getByTestId('codes-sheet');
		await expect(sheet).toBeVisible();
		const codes = await sheet.getByTestId('recovery-code').locator('.value').allTextContents();
		expect(codes).toHaveLength(10);
		await expect(sheet.getByTestId('codes-done')).toBeDisabled();
		await captureScreen(page, testInfo, 'security-new-codes');
		await sheet.getByTestId('ack-codes').check();
		await sheet.getByTestId('codes-done').click();
		await expect(page.getByTestId('codes-remaining')).toContainText('10');

		// Another device, signed out, with no passkey for this account.
		const device = await browser.newContext({ storageState: signedOut });
		const other = await device.newPage();
		const authenticator = await addVirtualAuthenticator(other);
		await other.goto('/');
		await other.getByTestId('use-recovery-code').click();
		await expect(other).toHaveURL(/\/recover$/);
		await captureScreen(other, testInfo, 'recover');
		await audit(other, 'recover');

		await other.getByTestId('recovery-code-input').fill('AAAA-BBBB-CCCC-DDDD');
		await other.getByTestId('recovery-submit').click();
		await expect(other.getByRole('alert')).toContainText("That code didn't work");
		await captureScreen(other, testInfo, 'recover-error');

		// Forgiving input: lower case, no dashes.
		await other.getByTestId('recovery-code-input').fill(codes[0]!.toLowerCase().replace(/-/g, ''));
		await other.getByTestId('recovery-submit').click();
		await expect(other).toHaveURL(/\/recover\/passkey$/);
		await expect(other.getByTestId('codes-left')).toContainText('9 recovery codes left');
		await captureScreen(other, testInfo, 'recover-passkey');
		await audit(other, 'recover passkey');

		// Until a new passkey exists, the recovery session reaches nothing else.
		await other.goto('/today');
		await expect(other).toHaveURL(/\/recover\/passkey$/);
		const vitals = await other.request.post('/api/vitals', { headers: SAME_ORIGIN, data: [] });
		expect(vitals.status()).toBe(403);
		expect(await vitals.json()).toMatchObject({ error: 'passkey_required' });

		await other.getByTestId('create-recovery-passkey').click();
		await expect(other).toHaveURL(/\/profile\/security\?recovered=1$/);
		await expect(other.getByTestId('recovered-notice')).toBeVisible();
		expect(await authenticator.credentials()).toHaveLength(1);
		await captureScreen(other, testInfo, 'security-recovered');
		await other.goto('/today');
		await expect(other.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();

		// The code is burned for good.
		const used = await query<{ n: number }>(
			'select count(*)::int as n from recovery_codes where used_at is not null'
		);
		expect(used[0]!.n).toBe(1);
		const again = await browser.newContext({ storageState: signedOut });
		const third = await again.newPage();
		await third.goto('/recover');
		await third.getByTestId('recovery-code-input').fill(codes[0]!);
		await third.getByTestId('recovery-submit').click();
		await expect(third.getByRole('alert')).toContainText("That code didn't work");

		// A code in someone else's hands: the owner sees that recovery sign-in, flagged, and ends it.
		await third.getByTestId('recovery-code-input').fill(codes[1]!);
		await third.getByTestId('recovery-submit').click();
		await expect(third).toHaveURL(/\/recover\/passkey$/);
		const [recovery] = await query<{ id: string }>(
			'select id from auth_sessions where token_hash = $1',
			[sha256((await sessionCookie(again))!.value)]
		);
		await page.goto('/profile/security');
		const row = page.locator(`[data-session-id="${recovery!.id}"]`);
		await expect(row).toContainText('Recovery sign-in');
		await row.scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, 'security-recovery-session');
		await audit(page, 'security with a recovery sign-in');
		await row.getByTestId('revoke-session').click();
		await expect(toastWith(page, /Signed out /)).toBeVisible();
		await expect(row).toHaveCount(0);
		await third.goto('/recover/passkey');
		await expect(third.getByTestId('signin-screen')).toBeVisible();
		await again.close();
		await device.close();
	});

	test('sessions: this device is marked and another device can be signed out', async ({
		browser
	}, testInfo) => {
		const a = await ownDevice(browser);
		const b = await ownDevice(browser);

		await a.page.goto('/profile/security');
		await expect(a.page.locator(`[data-session-id="${a.sessionId}"]`)).toHaveAttribute(
			'data-current',
			'true'
		);
		await expect(
			a.page.locator(`[data-session-id="${a.sessionId}"]`).getByTestId('revoke-session')
		).toHaveCount(0);
		const bRow = a.page.locator(`[data-session-id="${b.sessionId}"]`);
		await expect(bRow).toHaveAttribute('data-current', 'false');
		await captureScreen(a.page, testInfo, 'security-sessions');
		await bRow.getByTestId('revoke-session').click();
		await expect(toastWith(a.page, /Signed out /)).toBeVisible();
		await expect(bRow).toHaveCount(0);

		// B is signed out on its next request; A is not.
		await b.page.goto('/today');
		await expect(b.page).toHaveURL(/\/\?next=%2Ftoday$/);
		await a.page.goto('/today');
		await expect(a.page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
		await a.context.close();
		await b.context.close();
	});

	test('sign-out clears the session cookie, account caches and IndexedDB, keeps preferences', async ({
		browser
	}, testInfo) => {
		const { context, page, sessionId } = await ownDevice(browser);
		await page.goto('/profile');
		await page.getByTestId('theme-control').getByRole('radio', { name: 'Light' }).click();
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
			timeout: 15_000
		});
		// Account data a device can hold: cached responses and the offline store (M4).
		await page.evaluate(async () => {
			const cache = await caches.open('pc-account-data');
			await cache.put('/api/private', new Response('{"secret":true}'));
			await new Promise<void>((resolve, reject) => {
				const open = indexedDB.open('pc-offline', 1);
				open.onupgradeneeded = () => open.result.createObjectStore('sets');
				open.onsuccess = () => {
					open.result.close();
					resolve();
				};
				open.onerror = () => reject(open.error);
			});
		});
		expect(await page.evaluate(() => caches.keys())).toContain('pc-account-data');

		await page.goto('/profile/security');
		const [response] = await Promise.all([
			page.waitForResponse((r) => r.url().endsWith('/api/auth/signout')),
			page.getByTestId('sign-out').click()
		]);
		expect(response.status()).toBe(200);
		expect((await response.allHeaders())['clear-site-data']).toBe('"cache"');
		await expect(page).toHaveURL(/\/\?signedOut=1$/);
		await expect(page.getByTestId('signed-out-notice')).toBeVisible();
		await captureScreen(page, testInfo, 'signed-out');

		expect(await sessionCookie(context)).toBeUndefined();
		const left = await page.evaluate(async () => ({
			caches: await caches.keys(),
			databases: (await indexedDB.databases()).map((d) => d.name),
			theme: JSON.parse(localStorage.getItem('pc:prefs:v1') ?? '{}').theme
		}));
		expect(left.caches.every((k) => k.startsWith('pc-shell-'))).toBe(true);
		expect(left.caches).toHaveLength(1); // the versioned app shell survives (offline still works)
		expect(left.databases).toEqual([]);
		expect(left.theme).toBe('light');
		expect(
			await query('select revoked_reason from auth_sessions where id = $1', [sessionId])
		).toEqual([{ revoked_reason: 'signout' }]);

		await page.goto('/today');
		await expect(page).toHaveURL(/\/\?next=%2Ftoday$/);
		await context.close();
	});
});
