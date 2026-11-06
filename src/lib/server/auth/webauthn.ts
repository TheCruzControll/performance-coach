/**
 * Thin, typed wrappers around SimpleWebAuthn (@simplewebauthn/server) with this app's policy:
 * discoverable credentials (resident keys) required, user verification required, no
 * attestation, and responses shape-checked before they reach the library.
 */
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON,
	type RegistrationResponseJSON,
	type WebAuthnCredential
} from '@simplewebauthn/server';
import { z } from 'zod';
import type { PasskeyRow } from '../db';
import { AuthError } from './errors';
import { CHALLENGE } from './policy';
import type { RelyingParty } from './relying-party';

const b64url = (max: number) =>
	z
		.string()
		.max(max)
		.regex(/^[A-Za-z0-9_-]*$/, 'must be base64url');

const transports = z.array(z.string().max(32)).max(10).optional();

const registrationSchema = z.looseObject({
	id: b64url(1024).min(1),
	rawId: b64url(1024).min(1),
	type: z.literal('public-key'),
	response: z.looseObject({
		clientDataJSON: b64url(4096).min(1),
		attestationObject: b64url(32_768).min(1),
		transports
	}),
	clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
	authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional()
});

const authenticationSchema = z.looseObject({
	id: b64url(1024).min(1),
	rawId: b64url(1024).min(1),
	type: z.literal('public-key'),
	response: z.looseObject({
		clientDataJSON: b64url(4096).min(1),
		authenticatorData: b64url(4096).min(1),
		signature: b64url(4096).min(1),
		userHandle: b64url(256).optional()
	}),
	clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
	authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional()
});

export function parseRegistrationResponse(input: unknown): RegistrationResponseJSON {
	const parsed = registrationSchema.safeParse(input);
	if (!parsed.success) throw new AuthError('invalid_input', 'Malformed passkey response.');
	return parsed.data as unknown as RegistrationResponseJSON;
}

export function parseAuthenticationResponse(input: unknown): AuthenticationResponseJSON {
	const parsed = authenticationSchema.safeParse(input);
	if (!parsed.success) throw new AuthError('invalid_input', 'Malformed passkey response.');
	return parsed.data as unknown as AuthenticationResponseJSON;
}

const credentialId = b64url(1024).min(1);

/**
 * A passkey id in the shape the responses above carry (and the database stores): base64url.
 * Anything else names no passkey, and some values (a NUL byte) make Postgres throw instead.
 */
export function isCredentialId(value: unknown): value is string {
	return credentialId.safeParse(value).success;
}

const toBytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64url'));

export function registrationOptions(input: {
	rp: RelyingParty;
	userHandle: string;
	userName: string;
	exclude?: Pick<PasskeyRow, 'id' | 'transports'>[];
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
	return generateRegistrationOptions({
		rpName: input.rp.rpName,
		rpID: input.rp.rpID,
		userID: toBytes(input.userHandle),
		userName: input.userName,
		userDisplayName: input.userName,
		timeout: CHALLENGE.ceremonyMs,
		attestationType: 'none',
		excludeCredentials: (input.exclude ?? []).map((c) => ({
			id: c.id,
			transports: c.transports
		})),
		authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
	});
}

/**
 * Without `allow` (sign-in): discoverable credentials, the browser offers the owner's passkeys.
 * With it (step-up): only these passkeys are acceptable.
 */
export function authenticationOptions(
	rp: RelyingParty,
	allow?: Pick<PasskeyRow, 'id' | 'transports'>[]
) {
	return generateAuthenticationOptions({
		rpID: rp.rpID,
		timeout: CHALLENGE.ceremonyMs,
		userVerification: 'required',
		allowCredentials: allow?.map((c) => ({ id: c.id, transports: c.transports }))
	}) satisfies Promise<PublicKeyCredentialRequestOptionsJSON>;
}

export async function verifyRegistration(
	response: RegistrationResponseJSON,
	expected: { challenge: string; rp: RelyingParty }
) {
	try {
		const result = await verifyRegistrationResponse({
			response,
			expectedChallenge: expected.challenge,
			expectedOrigin: expected.rp.origin,
			expectedRPID: expected.rp.rpID,
			requireUserVerification: true
		});
		if (!result.verified) throw new Error('registration not verified');
		return result.registrationInfo;
	} catch (err) {
		throw new AuthError('verification_failed', 'This passkey could not be verified.', {}, err);
	}
}

export async function verifyAuthentication(
	response: AuthenticationResponseJSON,
	expected: { challenge: string; rp: RelyingParty; credential: PasskeyRow }
) {
	const credential: WebAuthnCredential = {
		id: expected.credential.id,
		publicKey: expected.credential.publicKey,
		counter: expected.credential.counter,
		transports: expected.credential.transports
	};
	try {
		const result = await verifyAuthenticationResponse({
			response,
			expectedChallenge: expected.challenge,
			expectedOrigin: expected.rp.origin,
			expectedRPID: expected.rp.rpID,
			credential,
			requireUserVerification: true
		});
		if (!result.verified) throw new Error('assertion not verified');
		return result.authenticationInfo;
	} catch (err) {
		throw new AuthError('verification_failed', 'This passkey could not be verified.', {}, err);
	}
}
