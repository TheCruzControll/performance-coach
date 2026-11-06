/**
 * Passkey ceremonies in the browser: fetch options from the server, run WebAuthn through
 * @simplewebauthn/browser, post the result back. The library is imported on demand, so it is
 * never part of any route's initial JavaScript and only loads on the sign-in, setup, recovery
 * and security screens (checked by `pnpm budgets`).
 */
import type * as WebAuthnBrowser from '@simplewebauthn/browser';
import type {
	AuthenticationResponseJSON,
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON,
	RegistrationResponseJSON
} from '@simplewebauthn/browser';

let library: Promise<typeof WebAuthnBrowser> | undefined;
const loadLibrary = () => (library ??= import('@simplewebauthn/browser'));

export type PasskeyErrorKind =
	| 'cancelled'
	| 'unsupported'
	| 'already-registered'
	| 'rejected'
	| 'rate-limited'
	| 'expired'
	| 'unavailable'
	| 'network'
	| 'reauth';

/**
 * A failure worth explaining to the owner, in plain words. `stage` says where it happened: in the
 * browser's passkey prompt, or at the server after the browser produced a response.
 */
export class PasskeyError extends Error {
	readonly kind: PasskeyErrorKind;
	readonly stage: 'browser' | 'server';
	constructor(kind: PasskeyErrorKind, message: string, stage: 'browser' | 'server' = 'server') {
		super(message);
		this.name = 'PasskeyError';
		this.kind = kind;
		this.stage = stage;
	}
}

const MESSAGES: Record<PasskeyErrorKind, string> = {
	cancelled: 'Passkey request cancelled. Try again when you’re ready.',
	unsupported: 'This browser can’t use passkeys. Try Safari on your iPhone.',
	'already-registered': 'This device already has a passkey for Performance Coach.',
	rejected: 'That passkey wasn’t accepted.',
	'rate-limited': 'Too many attempts. Wait a minute and try again.',
	expired: 'That request expired. Try again.',
	unavailable: 'Passkeys aren’t available on this address.',
	network: 'Can’t reach the server. Check your connection and try again.',
	reauth: 'Confirm it’s you with one of your passkeys.'
};

const fail = (kind: PasskeyErrorKind, message = MESSAGES[kind]) => new PasskeyError(kind, message);

interface ApiError {
	error?: string;
	message?: string;
}

async function post<T>(url: string, body: unknown = {}): Promise<T> {
	let res: Response;
	try {
		res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify(body),
			credentials: 'same-origin'
		});
	} catch {
		throw fail('network');
	}
	const data = (await res.json().catch(() => ({}))) as T & ApiError;
	if (res.ok) return data;
	switch (data.error) {
		case 'rate_limited':
			throw fail('rate-limited');
		case 'challenge_invalid':
			throw fail('expired');
		case 'wrong_origin':
			throw fail('unavailable', data.message ?? MESSAGES.unavailable);
		case 'already_registered':
			throw fail('already-registered');
		case 'reauth_required':
			throw fail('reauth');
		default:
			throw fail('rejected', data.message ?? MESSAGES.rejected);
	}
}

function fromBrowserError(error: unknown): PasskeyError {
	if (error instanceof PasskeyError) return error;
	const { code, name, cause } = error as { code?: string; name?: string; cause?: unknown };
	const causeName = (cause as { name?: string } | undefined)?.name;
	const browser = (kind: PasskeyErrorKind) => new PasskeyError(kind, MESSAGES[kind], 'browser');
	if (code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' || causeName === 'InvalidStateError') {
		return browser('already-registered');
	}
	if (code === 'ERROR_INVALID_DOMAIN' || code === 'ERROR_INVALID_RP_ID') {
		return browser('unavailable');
	}
	if (
		code === 'ERROR_CEREMONY_ABORTED' ||
		name === 'AbortError' ||
		name === 'NotAllowedError' ||
		causeName === 'NotAllowedError'
	) {
		return browser('cancelled');
	}
	return browser('rejected');
}

export interface PasskeySupport {
	webauthn: boolean;
	/** Conditional UI: the browser can offer passkeys in the autofill of a text field. */
	autofill: boolean;
}

export async function passkeySupport(): Promise<PasskeySupport> {
	const lib = await loadLibrary();
	const webauthn = lib.browserSupportsWebAuthn();
	return { webauthn, autofill: webauthn && (await lib.browserSupportsWebAuthnAutofill()) };
}

/**
 * Sign in with a discoverable passkey. With `autofill`, the request waits silently for the
 * owner to pick a passkey from the field's autofill (conditional UI); starting a modal sign-in
 * later aborts it (the library's abort service does that).
 */
export async function signInWithPasskey(
	options: { next?: string | null; autofill?: boolean } = {}
): Promise<{ redirectTo: string }> {
	const lib = await loadLibrary();
	if (!lib.browserSupportsWebAuthn())
		throw new PasskeyError('unsupported', MESSAGES.unsupported, 'browser');
	const optionsJSON = await post<PublicKeyCredentialRequestOptionsJSON>('/api/auth/signin/options');
	let response: AuthenticationResponseJSON;
	try {
		response = await lib.startAuthentication({
			optionsJSON,
			useBrowserAutofill: options.autofill ?? false
		});
	} catch (error) {
		throw fromBrowserError(error);
	}
	return post<{ redirectTo: string }>('/api/auth/signin/verify', {
		response,
		next: options.next ?? null
	});
}

/** First-run setup: create the owner's first passkey; returns the recovery codes (once). */
export async function createFirstPasskey(input: {
	token: string;
	name: string;
}): Promise<{ recoveryCodes: string[] }> {
	const lib = await loadLibrary();
	if (!lib.browserSupportsWebAuthn())
		throw new PasskeyError('unsupported', MESSAGES.unsupported, 'browser');
	const optionsJSON = await post<PublicKeyCredentialCreationOptionsJSON>(
		'/api/auth/setup/options',
		input
	);
	let response: RegistrationResponseJSON;
	try {
		response = await lib.startRegistration({ optionsJSON });
	} catch (error) {
		throw fromBrowserError(error);
	}
	return post<{ recoveryCodes: string[] }>('/api/auth/setup/verify', {
		token: input.token,
		response
	});
}

export interface AddedPasskey {
	passkey: { id: string; nickname: string };
	/** True when this finished a recovery sign-in (the session is now a full one). */
	recovered: boolean;
}

/** Add a passkey to the signed-in account (or replace a lost one after a recovery code). */
export async function addPasskey(): Promise<AddedPasskey> {
	const lib = await loadLibrary();
	if (!lib.browserSupportsWebAuthn())
		throw new PasskeyError('unsupported', MESSAGES.unsupported, 'browser');
	const optionsJSON = await post<PublicKeyCredentialCreationOptionsJSON>(
		'/api/auth/passkeys/options'
	);
	let response: RegistrationResponseJSON;
	try {
		response = await lib.startRegistration({ optionsJSON });
	} catch (error) {
		throw fromBrowserError(error);
	}
	return post<AddedPasskey>('/api/auth/passkeys/verify', { response });
}

/**
 * Step-up: confirm it's the owner with one of their existing passkeys (Face ID / Touch ID), so
 * the Security action the server refused with `reauth_required` can be retried.
 */
export async function reauthenticate(): Promise<void> {
	const lib = await loadLibrary();
	if (!lib.browserSupportsWebAuthn())
		throw new PasskeyError('unsupported', MESSAGES.unsupported, 'browser');
	const optionsJSON = await post<PublicKeyCredentialRequestOptionsJSON>('/api/auth/reauth/options');
	let response: AuthenticationResponseJSON;
	try {
		response = await lib.startAuthentication({ optionsJSON });
	} catch (error) {
		throw fromBrowserError(error);
	}
	await post('/api/auth/reauth/verify', { response });
}

/** Stop a pending autofill (conditional UI) request, e.g. when leaving the sign-in screen. */
export async function cancelPendingPasskeyRequest(): Promise<void> {
	if (library) (await library).WebAuthnAbortService.cancelCeremony();
}
