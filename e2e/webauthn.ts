/**
 * Real WebAuthn ceremonies in Chromium e2e: a CDP virtual authenticator (WebAuthn domain) that
 * behaves like a platform passkey provider — CTAP2, internal transport, resident keys and user
 * verification (Face ID / Touch ID), with presence answered automatically. Nothing about the
 * app is bypassed: the browser runs navigator.credentials.create/get and the server verifies
 * the results with @simplewebauthn/server.
 *
 * WebKit has no virtual authenticator, so passkey ceremonies are Chromium-only; WebKit runs the
 * rest of the suite on a session minted by the test-only route (e2e/auth-webkit.setup.ts).
 */
import type { BrowserContext, CDPSession, Page, TestInfo } from '@playwright/test';

export interface VirtualAuthenticator {
	cdp: CDPSession;
	authenticatorId: string;
	/** Credentials currently stored in the authenticator (passkeys it holds). */
	credentials(): Promise<{ credentialId: string; rpId?: string; signCount: number }[]>;
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
