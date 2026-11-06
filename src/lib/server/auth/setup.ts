/**
 * First-run setup: the one way an owner account comes to exist.
 *
 * The tech lead generates a random token (`pnpm auth:setup-token`) and configures only its
 * SHA-256 (`OWNER_SETUP_TOKEN_HASH`); the owner opens `/setup?token=…`. Setup is possible only
 * while no passkey exists; registering the first passkey creates the owner (or re-attaches the
 * existing one after `pnpm auth:reset-owner`), closes setup for good (the route answers 404 from
 * then on) and returns 10 recovery codes, shown exactly once. Each token works for one setup:
 * its hash is recorded when setup completes, so after a reset a new token is needed (the old
 * link sits in Vercel's request logs).
 */
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/server';
import { createAuthRepository } from '../db';
import { getEnv } from '../env';
import { recordAuthEvent } from './audit';
import { consumeChallenge, storeChallenge } from './challenges';
import { resolveDeps, type AuthDeps, type AuthRequest } from './context';
import { defaultPasskeyName } from './devices';
import { AuthError, failureReason, isAuthError } from './errors';
import { enforceRateLimit } from './rate-limit';
import { generateRecoveryCodes, hashRecoveryCode } from './recovery-codes';
import { issueSession, revokeToken, type IssuedSession } from './sessions';
import { generateUserHandle, hashToken, tokenMatchesHash } from './tokens';
import { parseRegistrationResponse, registrationOptions, verifyRegistration } from './webauthn';

const UNAVAILABLE = 'Setup is not available.';

export interface SetupConfig {
	/** Hex SHA-256 of the setup token; undefined disables setup. */
	tokenHash?: string;
}

const configFromEnv = (): SetupConfig => ({ tokenHash: getEnv().OWNER_SETUP_TOKEN_HASH });

/** Constant-time check of a presented setup token against the configured hash. */
export function setupTokenValid(token: unknown, config: SetupConfig = configFromEnv()): boolean {
	if (!config.tokenHash || typeof token !== 'string' || token.length < 16 || token.length > 256) {
		return false;
	}
	return tokenMatchesHash(token, config.tokenHash);
}

/** The presented token's hash if it is the configured token, else null. */
const validTokenHash = (token: unknown, config?: SetupConfig): string | null =>
	typeof token === 'string' && setupTokenValid(token, config) ? hashToken(token) : null;

/**
 * True while no passkey exists and setup has never completed — on a fresh database, or after
 * the tech lead ran `pnpm auth:reset-owner` (which keeps the owner and their training data but
 * removes every credential and reopens setup).
 */
export async function setupOpen(deps: AuthDeps = {}): Promise<boolean> {
	const { db } = resolveDeps(deps);
	const repo = createAuthRepository(db);
	const owner = await repo.getOwner();
	return (!owner || owner.setupCompletedAt === null) && (await repo.countPasskeys()) === 0;
}

/**
 * Can `/setup?token=…` be shown? Rate-limited (it checks a secret). Anything but a valid token
 * while setup is open looks the same from outside: 404.
 */
export async function checkSetupAccess(
	token: unknown,
	request: AuthRequest,
	deps: AuthDeps & { config?: SetupConfig } = {}
): Promise<boolean> {
	const { db, now } = resolveDeps(deps);
	if (!(await setupOpen({ db }))) return false;
	await enforceRateLimit('setup', { ip: request.ip }, request, { db, now });
	const tokenHash = validTokenHash(token, deps.config);
	// The configured token, but already spent: an old link after an owner reset. Audited apart.
	const used = tokenHash !== null && (await createAuthRepository(db).setupTokenUsed(tokenHash));
	if (!tokenHash || used) {
		await recordAuthEvent(db, request, {
			type: 'setup.failed',
			detail: { code: used ? 'token_used' : 'invalid_token' }
		});
	}
	return tokenHash !== null && !used;
}

export function parseOwnerName(input: unknown): string {
	const value = typeof input === 'string' ? input.trim().replace(/\s+/g, ' ') : '';
	if (value.length < 1 || value.length > 64) {
		throw new AuthError('invalid_input', 'Enter your name (up to 64 characters).');
	}
	return value;
}

/** Returns the hash of the presented token: the configured one, not yet used for a setup. */
async function assertSetupAllowed(
	token: unknown,
	request: AuthRequest,
	deps: AuthDeps & { config?: SetupConfig }
): Promise<string> {
	const { db, now } = resolveDeps(deps);
	await enforceRateLimit('setup', { ip: request.ip }, request, { db, now });
	const tokenHash = validTokenHash(token, deps.config);
	if (
		!tokenHash ||
		(await createAuthRepository(db).setupTokenUsed(tokenHash)) ||
		!(await setupOpen({ db }))
	) {
		await recordAuthEvent(db, request, {
			type: 'setup.failed',
			detail: { code: 'setup_unavailable' }
		});
		throw new AuthError('setup_unavailable', UNAVAILABLE);
	}
	return tokenHash;
}

export async function beginSetup(
	input: { token: unknown; name: unknown },
	request: AuthRequest,
	deps: AuthDeps & { config?: SetupConfig } = {}
): Promise<PublicKeyCredentialCreationOptionsJSON> {
	const { db, now } = resolveDeps(deps);
	if (!request.rp) throw new AuthError('wrong_origin', 'Passkeys are not available here.');
	await assertSetupAllowed(input.token, request, deps);
	const name = parseOwnerName(input.name);
	const userHandle = generateUserHandle();
	const options = await registrationOptions({ rp: request.rp, userHandle, userName: name });
	await storeChallenge(
		{
			challenge: options.challenge,
			purpose: 'setup',
			rpId: request.rp.rpID,
			data: { name, userHandle }
		},
		{ db, now }
	);
	return options;
}

export interface CompletedSetup extends IssuedSession {
	ownerId: string;
	/** Plain-text recovery codes: returned once, never stored, never retrievable again. */
	recoveryCodes: string[];
}

export async function completeSetup(
	input: { token: unknown; response: unknown },
	presentedToken: string | undefined,
	request: AuthRequest,
	deps: AuthDeps & { config?: SetupConfig } = {}
): Promise<CompletedSetup> {
	const { db, now } = resolveDeps(deps);
	const rp = request.rp;
	if (!rp) throw new AuthError('wrong_origin', 'Passkeys are not available here.');
	const tokenHash = await assertSetupAllowed(input.token, request, deps);
	const response = parseRegistrationResponse(input.response);

	try {
		const challenge = await consumeChallenge(
			response.response.clientDataJSON,
			{ purpose: 'setup', rpId: rp.rpID },
			{ db, now }
		);
		const { name, userHandle } = challenge.data as { name: string; userHandle: string };
		const info = await verifyRegistration(response, { challenge: challenge.challenge, rp });
		const codes = generateRecoveryCodes();

		const result = await db.transaction(async (tx) => {
			const repo = createAuthRepository(tx);
			await repo.lockOwnerSetup();
			if (!(await setupOpen({ db: tx }))) {
				throw new AuthError('setup_unavailable', UNAVAILABLE);
			}
			const at = now();
			// Spend the token with the setup it completes (atomically: a token completes one
			// setup), so the same link never reopens the account after `pnpm auth:reset-owner`.
			if (!(await repo.claimSetupToken(tokenHash, at))) {
				throw new AuthError('setup_unavailable', UNAVAILABLE);
			}
			const existing = await repo.getOwner();
			const owner = existing
				? await repo.updateOwnerIdentity(existing.id, {
						displayName: name,
						webauthnUserId: userHandle
					})
				: await repo.insertOwner({ displayName: name, webauthnUserId: userHandle });
			const passkey = await repo.insertPasskey({
				id: info.credential.id,
				ownerId: owner.id,
				publicKey: info.credential.publicKey,
				counter: info.credential.counter,
				transports: info.credential.transports ?? [],
				deviceType: info.credentialDeviceType,
				backedUp: info.credentialBackedUp,
				aaguid: info.aaguid,
				nickname: defaultPasskeyName(info.aaguid, request.userAgent),
				createdAt: at
			});
			await repo.markSetupCompleted(owner.id, at);
			await repo.replaceRecoveryCodes(
				owner.id,
				codes.map((code) => hashRecoveryCode(code)!),
				at
			);
			await revokeToken(presentedToken, 'rotated', { db: tx, now });
			const issued = await issueSession(
				{
					ownerId: owner.id,
					method: 'setup',
					credentialId: passkey.id,
					userAgent: request.userAgent,
					reauthenticated: true
				},
				{ db: tx, now }
			);
			return { ...issued, ownerId: owner.id, passkeyId: passkey.id };
		});

		await recordAuthEvent(db, request, {
			type: 'setup.completed',
			ownerId: result.ownerId,
			sessionId: result.session.id,
			credentialId: result.passkeyId
		});
		return {
			token: result.token,
			session: result.session,
			ownerId: result.ownerId,
			recoveryCodes: codes
		};
	} catch (err) {
		if (isAuthError(err)) {
			await recordAuthEvent(db, request, {
				type: 'setup.failed',
				detail: { code: err.code, reason: failureReason(err) }
			});
		}
		throw err;
	}
}
