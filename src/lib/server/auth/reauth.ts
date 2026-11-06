/**
 * Step-up re-authentication (ASVS V3.7). A session cookie alone must not be enough to take the
 * account over, so adding or removing a passkey, creating new recovery codes and signing other
 * devices out need a user-verified assertion with one of the owner's existing passkeys on this
 * session within the last few minutes (`SESSION.reauthMs`). A sign-in, setup or the passkey
 * that finishes a recovery counts; otherwise the Security screen asks for one (begin/complete
 * below). A recovery session is exempt only for registering its new passkey (passkeys.ts).
 */
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';
import { createAuthRepository, type PasskeyRow } from '../db';
import { recordAuthEvent } from './audit';
import { consumeChallenge, storeChallenge } from './challenges';
import { resolveDeps, type AuthDeps, type AuthRequest } from './context';
import { AuthError, failureReason, isAuthError } from './errors';
import { SESSION } from './policy';
import { enforceRateLimit } from './rate-limit';
import type { RelyingParty } from './relying-party';
import type { AuthSession } from './sessions';
import {
	authenticationOptions,
	parseAuthenticationResponse,
	verifyAuthentication
} from './webauthn';

/** Throw `reauth_required` (403) unless this session verified a passkey recently enough. */
export function requireRecentAuthentication(session: AuthSession, now: Date): void {
	const at = session.reauthenticatedAt;
	if (!at || now.getTime() - at.getTime() > SESSION.reauthMs) {
		throw new AuthError('reauth_required', 'Confirm it’s you with one of your passkeys.');
	}
}

function ownerSessionRp(session: AuthSession, request: AuthRequest): RelyingParty {
	// A recovery session has no usable passkey: it can only register a new one.
	if (session.kind !== 'owner') {
		throw new AuthError('invalid_input', 'Add a new passkey to finish recovery.');
	}
	if (!request.rp) throw new AuthError('wrong_origin', 'Passkeys are not available here.');
	return request.rp;
}

/** Assertion options for one of the owner's passkeys, bound to this session. */
export async function beginReauthentication(
	session: AuthSession,
	request: AuthRequest,
	deps: AuthDeps = {}
): Promise<PublicKeyCredentialRequestOptionsJSON> {
	const { db, now } = resolveDeps(deps);
	const rp = ownerSessionRp(session, request);
	await enforceRateLimit('reauth', { session: session.id }, request, { db, now });
	const passkeys = await createAuthRepository(db).listPasskeys(session.ownerId);
	const options = await authenticationOptions(rp, passkeys);
	await storeChallenge(
		{
			challenge: options.challenge,
			purpose: 'reauthenticate',
			rpId: rp.rpID,
			sessionId: session.id
		},
		{ db, now }
	);
	return options;
}

/** Verify the assertion and mark this session as freshly authenticated. */
export async function completeReauthentication(
	session: AuthSession,
	body: unknown,
	request: AuthRequest,
	deps: AuthDeps = {}
): Promise<{ reauthenticatedAt: Date }> {
	const { db, now } = resolveDeps(deps);
	const rp = ownerSessionRp(session, request);
	await enforceRateLimit('reauth', { session: session.id }, request, { db, now });
	const response = parseAuthenticationResponse(body);

	let credential: PasskeyRow | null = null;
	try {
		const challenge = await consumeChallenge(
			response.response.clientDataJSON,
			{ purpose: 'reauthenticate', rpId: rp.rpID, sessionId: session.id },
			{ db, now }
		);
		credential = await createAuthRepository(db).findPasskey(response.id);
		if (!credential || credential.ownerId !== session.ownerId) {
			throw new AuthError('unknown_credential', 'This passkey is not registered here.');
		}
		const info = await verifyAuthentication(response, {
			challenge: challenge.challenge,
			rp,
			credential
		});
		const at = now();
		await db.transaction(async (tx) => {
			const repo = createAuthRepository(tx);
			const recorded = await repo.recordPasskeyUse(
				credential!.id,
				{
					counter: info.newCounter,
					backedUp: info.credentialBackedUp,
					deviceType: info.credentialDeviceType
				},
				at
			);
			if (!recorded) {
				// A newer counter was recorded meanwhile: possibly a cloned authenticator.
				throw new AuthError('verification_failed', 'This passkey could not be verified.');
			}
			if (!(await repo.markSessionReauthenticated(session.id, at))) {
				throw new AuthError('not_found', 'This session has ended. Sign in again.');
			}
		});
		await recordAuthEvent(db, request, {
			type: 'reauth.succeeded',
			ownerId: session.ownerId,
			sessionId: session.id,
			credentialId: credential.id
		});
		return { reauthenticatedAt: at };
	} catch (err) {
		if (isAuthError(err) && err.code !== 'rate_limited') {
			await recordAuthEvent(db, request, {
				type: 'reauth.failed',
				ownerId: session.ownerId,
				sessionId: session.id,
				credentialId: credential?.id ?? response.id.slice(0, 256),
				detail: { code: err.code, reason: failureReason(err) }
			});
		}
		throw err;
	}
}
