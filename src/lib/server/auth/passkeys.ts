/**
 * Passkey use-cases: sign in with a passkey, add another passkey (also how a recovery session
 * replaces a lost one), rename, remove (never the last) and list. Adding and removing need a
 * recent passkey assertion on the session (reauth.ts); renaming changes no credential and
 * does not.
 */
import type {
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON
} from '@simplewebauthn/server';
import { createAuthRepository, type PasskeyRow } from '../db';
import { recordAuthEvent } from './audit';
import { consumeChallenge, storeChallenge } from './challenges';
import { resolveDeps, type AuthDeps, type AuthRequest } from './context';
import { defaultPasskeyName, passkeyProvider } from './devices';
import { AuthError, failureReason, isAuthError } from './errors';
import { enforceRateLimit } from './rate-limit';
import { requireRecentAuthentication } from './reauth';
import type { RelyingParty } from './relying-party';
import { issueSession, revokeToken, type AuthSession, type IssuedSession } from './sessions';
import {
	authenticationOptions,
	isCredentialId,
	parseAuthenticationResponse,
	parseRegistrationResponse,
	registrationOptions,
	verifyAuthentication,
	verifyRegistration
} from './webauthn';

function requireRp(request: AuthRequest): RelyingParty {
	if (!request.rp) throw new AuthError('wrong_origin', 'Passkeys are not available here.');
	return request.rp;
}

// ---- sign in -------------------------------------------------------------------------------

export async function beginSignIn(
	request: AuthRequest,
	deps: AuthDeps = {}
): Promise<PublicKeyCredentialRequestOptionsJSON> {
	const { db, now } = resolveDeps(deps);
	const rp = requireRp(request);
	await enforceRateLimit('signin.options', { ip: request.ip }, request, { db, now });
	const options = await authenticationOptions(rp);
	await storeChallenge(
		{ challenge: options.challenge, purpose: 'authenticate', rpId: rp.rpID },
		{ db, now }
	);
	return options;
}

/**
 * Verify a passkey assertion and start a new session. `presentedToken` is whatever session
 * cookie the device sent: it is revoked (session rotation).
 */
export async function completeSignIn(
	body: unknown,
	presentedToken: string | undefined,
	request: AuthRequest,
	deps: AuthDeps = {}
): Promise<IssuedSession> {
	const { db, now } = resolveDeps(deps);
	const rp = requireRp(request);
	await enforceRateLimit('signin.verify', { ip: request.ip }, request, { db, now });
	const response = parseAuthenticationResponse(body);
	const repo = createAuthRepository(db);

	let credential: PasskeyRow | null = null;
	try {
		const challenge = await consumeChallenge(
			response.response.clientDataJSON,
			{ purpose: 'authenticate', rpId: rp.rpID },
			{ db, now }
		);
		credential = await repo.findPasskey(response.id);
		if (!credential) {
			throw new AuthError('unknown_credential', 'This passkey is not registered here.');
		}
		const owner = await repo.getOwner();
		if (
			!owner ||
			owner.id !== credential.ownerId ||
			(response.response.userHandle && response.response.userHandle !== owner.webauthnUserId)
		) {
			throw new AuthError('unknown_credential', 'This passkey is not registered here.');
		}
		const info = await verifyAuthentication(response, {
			challenge: challenge.challenge,
			rp,
			credential
		});

		const issued = await db.transaction(async (tx) => {
			const txRepo = createAuthRepository(tx);
			const recorded = await txRepo.recordPasskeyUse(
				credential!.id,
				{
					counter: info.newCounter,
					backedUp: info.credentialBackedUp,
					deviceType: info.credentialDeviceType
				},
				now()
			);
			if (!recorded) {
				// Another sign-in with a newer counter won the race: possibly a cloned authenticator.
				throw new AuthError('verification_failed', 'This passkey could not be verified.');
			}
			await revokeToken(presentedToken, 'rotated', { db: tx, now });
			return issueSession(
				{
					ownerId: owner.id,
					method: 'passkey',
					credentialId: credential!.id,
					userAgent: request.userAgent,
					reauthenticated: true
				},
				{ db: tx, now }
			);
		});
		await recordAuthEvent(db, request, {
			type: 'signin.succeeded',
			ownerId: owner.id,
			sessionId: issued.session.id,
			credentialId: credential.id
		});
		return issued;
	} catch (err) {
		if (isAuthError(err) && err.code !== 'rate_limited') {
			await recordAuthEvent(db, request, {
				type: 'signin.failed',
				ownerId: credential?.ownerId ?? null,
				credentialId: credential?.id ?? response.id.slice(0, 256),
				detail: { code: err.code, reason: failureReason(err) }
			});
		}
		throw err;
	}
}

// ---- add a passkey -------------------------------------------------------------------------

export async function beginPasskeyRegistration(
	session: AuthSession,
	request: AuthRequest,
	deps: AuthDeps = {}
): Promise<PublicKeyCredentialCreationOptionsJSON> {
	const { db, now } = resolveDeps(deps);
	const rp = requireRp(request);
	// A recovery session has no passkey to confirm with: it may register its new one. Checked
	// when the ceremony starts (the challenge is bound to this session and lives 5 minutes):
	// refusing at the end would leave a passkey on the device that the server never stored.
	if (session.kind === 'owner') requireRecentAuthentication(session, now());
	await enforceRateLimit('register', { session: session.id }, request, { db, now });
	const repo = createAuthRepository(db);
	const owner = await repo.getOwner();
	if (!owner || owner.id !== session.ownerId) throw new AuthError('not_found', 'No owner.');
	const options = await registrationOptions({
		rp,
		userHandle: owner.webauthnUserId,
		userName: owner.displayName,
		exclude: await repo.listPasskeys(owner.id)
	});
	await storeChallenge(
		{
			challenge: options.challenge,
			purpose: 'register',
			rpId: rp.rpID,
			sessionId: session.id
		},
		{ db, now }
	);
	return options;
}

/** The session behind the request was revoked or expired after the guard validated it. */
const sessionEnded = () => new AuthError('not_found', 'This session has ended. Sign in again.');

export interface RegisteredPasskey {
	passkey: PasskeyView;
	/** A recovery session is rotated into a full owner session once it has a new passkey. */
	upgradedSession?: IssuedSession;
}

export async function completePasskeyRegistration(
	session: AuthSession,
	body: unknown,
	request: AuthRequest,
	deps: AuthDeps = {}
): Promise<RegisteredPasskey> {
	const { db, now } = resolveDeps(deps);
	const rp = requireRp(request);
	await enforceRateLimit('register', { session: session.id }, request, { db, now });
	const response = parseRegistrationResponse(body);
	const challenge = await consumeChallenge(
		response.response.clientDataJSON,
		{ purpose: 'register', rpId: rp.rpID, sessionId: session.id },
		{ db, now }
	);
	const info = await verifyRegistration(response, { challenge: challenge.challenge, rp });

	const result = await db.transaction(async (tx) => {
		const repo = createAuthRepository(tx);
		// The guard validated the session when the request arrived; it may have been revoked since
		// (e.g. "Sign out everywhere else"). Hold it live until the passkey and upgrade are stored.
		if (!(await repo.lockLiveSession(session.id, now))) throw sessionEnded();
		if (await repo.findPasskey(info.credential.id)) {
			throw new AuthError('already_registered', 'This passkey is already registered.');
		}
		const passkey = await repo.insertPasskey({
			id: info.credential.id,
			ownerId: session.ownerId,
			publicKey: info.credential.publicKey,
			counter: info.credential.counter,
			transports: info.credential.transports ?? [],
			deviceType: info.credentialDeviceType,
			backedUp: info.credentialBackedUp,
			aaguid: info.aaguid,
			nickname: defaultPasskeyName(info.aaguid, request.userAgent),
			createdAt: now()
		});
		let upgradedSession: IssuedSession | undefined;
		if (session.kind === 'recovery') {
			if (!(await repo.revokeSession(session.id, 'recovered', now()))) throw sessionEnded();
			upgradedSession = await issueSession(
				{
					ownerId: session.ownerId,
					method: 'recovery',
					credentialId: passkey.id,
					userAgent: request.userAgent,
					// The new passkey was just verified (UV): removing the lost one needs no second prompt.
					reauthenticated: true
				},
				{ db: tx, now }
			);
		}
		return { passkey, upgradedSession };
	});
	await recordAuthEvent(db, request, {
		type: 'passkey.added',
		ownerId: session.ownerId,
		sessionId: result.upgradedSession?.session.id ?? session.id,
		credentialId: result.passkey.id,
		detail: { viaRecovery: session.kind === 'recovery' }
	});
	return { passkey: toView(result.passkey), upgradedSession: result.upgradedSession };
}

// ---- manage --------------------------------------------------------------------------------

export interface PasskeyView {
	id: string;
	nickname: string;
	provider: string | null;
	synced: boolean;
	createdAt: Date;
	lastUsedAt: Date | null;
}

function toView(row: PasskeyRow): PasskeyView {
	return {
		id: row.id,
		nickname: row.nickname,
		provider: passkeyProvider(row.aaguid),
		synced: row.backedUp,
		createdAt: row.createdAt,
		lastUsedAt: row.lastUsedAt
	};
}

export async function listPasskeys(
	session: AuthSession,
	deps: AuthDeps = {}
): Promise<PasskeyView[]> {
	const { db } = resolveDeps(deps);
	return (await createAuthRepository(db).listPasskeys(session.ownerId)).map(toView);
}

export function parseNickname(input: unknown): string {
	const value = typeof input === 'string' ? input.trim().replace(/\s+/g, ' ') : '';
	if (value.length < 1 || value.length > 64) {
		throw new AuthError('invalid_input', 'Give the passkey a name of 1–64 characters.');
	}
	return value;
}

export async function renamePasskey(
	session: AuthSession,
	id: string,
	nickname: unknown,
	request: AuthRequest,
	deps: AuthDeps = {}
): Promise<string> {
	const { db, now } = resolveDeps(deps);
	await enforceRateLimit('manage', { session: session.id }, request, { db, now });
	const name = parseNickname(nickname);
	if (
		!isCredentialId(id) ||
		!(await createAuthRepository(db).renamePasskey(session.ownerId, id, name))
	) {
		throw new AuthError('not_found', 'That passkey no longer exists.');
	}
	await recordAuthEvent(db, request, {
		type: 'passkey.renamed',
		ownerId: session.ownerId,
		sessionId: session.id,
		credentialId: id,
		detail: { nickname: name }
	});
	return name;
}

/**
 * Remove a passkey. Never the last one (checked under a row lock, so two concurrent removals
 * cannot both pass). Other sessions signed in with it are ended with it.
 */
export async function removePasskey(
	session: AuthSession,
	id: string,
	request: AuthRequest,
	deps: AuthDeps = {}
): Promise<{ endedSessions: number }> {
	const { db, now } = resolveDeps(deps);
	requireRecentAuthentication(session, now());
	await enforceRateLimit('manage', { session: session.id }, request, { db, now });
	const endedSessions = await db.transaction(async (tx) => {
		const repo = createAuthRepository(tx);
		const total = await repo.lockPasskeys(session.ownerId);
		const target = isCredentialId(id) ? await repo.findPasskey(id) : null;
		if (!target || target.ownerId !== session.ownerId) {
			throw new AuthError('not_found', 'That passkey no longer exists.');
		}
		if (total <= 1) {
			throw new AuthError(
				'last_passkey',
				'This is your only passkey. Add another before removing it.'
			);
		}
		const ended = await repo.revokeSessionsUsingPasskey(id, session.id, 'passkey_removed', now());
		await repo.deletePasskey(session.ownerId, id);
		return ended;
	});
	await recordAuthEvent(db, request, {
		type: 'passkey.removed',
		ownerId: session.ownerId,
		sessionId: session.id,
		credentialId: id,
		detail: { endedSessions }
	});
	return { endedSessions };
}
