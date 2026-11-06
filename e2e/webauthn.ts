/**
 * Real WebAuthn ceremonies in Chromium e2e: a CDP virtual authenticator (WebAuthn domain) that
 * behaves like a platform passkey provider — CTAP2, internal transport, resident keys and user
 * verification (Face ID / Touch ID), with presence answered automatically. Nothing about the
 * app is bypassed: the browser runs navigator.credentials.create/get and the server verifies
 * the results with @simplewebauthn/server.
 *
 * WebKit has no virtual authenticator, so passkey ceremonies are Chromium-only; WebKit runs the
 * rest of the suite on a session minted by the test-only route (e2e/auth-webkit.setup.ts).
 *
 * Signing in as the owner: auth.setup.ts registers one owner passkey per worker and exports it
 * (private key included, as the authenticator holds it). A spec imports its worker's passkey
 * into an authenticator of its own and signs in with it, for real (`signInAsOwner`).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import {
	expect,
	type BrowserContext,
	type CDPSession,
	type Page,
	type TestInfo
} from '@playwright/test';
import { gotoHydrated, ORIGIN, query } from './support';

/** A passkey as the virtual authenticator holds it (base64 ids, PKCS#8 private key). */
export interface StoredPasskey {
	credentialId: string;
	isResidentCredential: boolean;
	rpId?: string;
	privateKey: string;
	userHandle?: string;
	signCount: number;
}

export interface VirtualAuthenticator {
	cdp: CDPSession;
	authenticatorId: string;
	/** Credentials currently stored in the authenticator (passkeys it holds). */
	credentials(): Promise<StoredPasskey[]>;
	/** Make the next ceremonies fail user verification (or succeed again). */
	setUserVerified(verified: boolean): Promise<void>;
	remove(): Promise<void>;
}

export async function addVirtualAuthenticator(
	page: Page,
	context: BrowserContext = page.context()
): Promise<VirtualAuthenticator> {
	const cdp = await context.newCDPSession(page);
	await cdp.send('WebAuthn.enable', { enableUI: false });
	const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true
		}
	});
	return {
		cdp,
		authenticatorId,
		async credentials() {
			const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
			return credentials;
		},
		async setUserVerified(isUserVerified: boolean) {
			await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified });
		},
		async remove() {
			await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
		}
	};
}

/** Skip a test outside Chromium: the virtual authenticator is a CDP (Chromium) feature. */
export const chromiumOnly = [
	({ browserName }: { browserName: string }) => browserName !== 'chromium',
	'WebAuthn virtual authenticators are a Chromium DevTools Protocol feature (WebKit has none)'
] as const;

export function skipUnlessChromium(testInfo: TestInfo, browserName: string) {
	testInfo.skip(browserName !== 'chromium', chromiumOnly[1]);
}

/** The authenticator's base64 credential id as the server stores it (base64url). */
export const toBase64Url = (b64: string) => Buffer.from(b64, 'base64').toString('base64url');

const OWNER_PASSKEYS = 'e2e/.auth/owner-passkeys.json';

/** auth.setup.ts: keep the owner passkeys it registered, one per worker. */
export function saveOwnerPasskeys(passkeys: StoredPasskey[]) {
	writeFileSync(OWNER_PASSKEYS, JSON.stringify(passkeys));
}

/**
 * A virtual authenticator on `page` holding this worker's owner passkey. One per worker, so no
 * two tests use the same passkey at once: its signature counter (picked up from Postgres) must
 * only ever increase.
 */
export async function ownerPasskey(page: Page, testInfo: TestInfo): Promise<VirtualAuthenticator> {
	const passkeys = JSON.parse(readFileSync(OWNER_PASSKEYS, 'utf8')) as StoredPasskey[];
	const passkey = passkeys[testInfo.parallelIndex % passkeys.length]!;
	const [stored] = await query<{ counter: string }>(
		'select counter from passkey_credentials where id = $1',
		[toBase64Url(passkey.credentialId)]
	);
	expect(stored, 'this worker’s owner passkey is registered (auth.setup.ts)').toBeTruthy();
	const authenticator = await addVirtualAuthenticator(page);
	await authenticator.cdp.send('WebAuthn.addCredential', {
		authenticatorId: authenticator.authenticatorId,
		credential: { ...passkey, signCount: Number(stored!.counter) }
	});
	return authenticator;
}

/**
 * Browsers without conditional UI (passkeys offered in autofill): the button is the way in.
 * Where conditional UI exists, Chromium's virtual authenticator answers it at once, which
 * signs in without a tap; that path has its own test.
 */
export async function withoutPasskeyAutofill(page: Page) {
	await page.addInitScript(() => {
		Object.defineProperty(PublicKeyCredential, 'isConditionalMediationAvailable', {
			value: async () => false
		});
	});
}

/** The id of the session `context` holds. */
export async function currentSessionId(context: BrowserContext): Promise<string> {
	const cookie = (await context.cookies(ORIGIN)).find((c) => /session$/.test(c.name));
	expect(cookie, 'a session cookie').toBeTruthy();
	const hash = createHash('sha256').update(cookie!.value).digest('hex');
	const [row] = await query<{ id: string }>('select id from auth_sessions where token_hash = $1', [
		hash
	]);
	return row!.id;
}

/**
 * Sign `context` in as the owner: a real passkey ceremony from the sign-in screen with this
 * worker's owner passkey, on a page of its own (closed afterwards, with its authenticator).
 * The session has just used a passkey, so Security actions need no step-up for 5 minutes.
 * Cookies are cleared first: the sign-in must never rotate (revoke) the shared session.
 */
export async function signInAsOwner(context: BrowserContext, testInfo: TestInfo): Promise<string> {
	await context.clearCookies();
	// Every spec signs in from the same address, so they share its per-client sign-in limit
	// (src/lib/server/auth/policy.ts): each sign-in starts from a fresh budget.
	await query(`delete from auth_rate_limits where key like 'signin.%'`);
	const page = await context.newPage();
	await ownerPasskey(page, testInfo);
	await withoutPasskeyAutofill(page);
	// Hydrated first: `load` comes before SvelteKit has fetched its root error page and started,
	// and a tap before then submits the sign-in form as a plain GET (`/?username=`).
	await gotoHydrated(page, '/');
	await page.getByTestId('passkey-signin').click();
	await expect(page).toHaveURL(/\/today$/);
	await page.close();
	return currentSessionId(context);
}
