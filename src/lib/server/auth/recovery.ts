/**
 * Recovery codes: 10 single-use codes, created at setup and on regeneration, stored hashed.
 *
 * Signing in with a code burns it (atomically: a code works once, even under concurrent use)
 * and grants a short *recovery* session that can only register a new passkey; registering one
 * rotates it into a full session (passkeys.ts). Regenerating replaces every code, used or not.
 */
import { createAuthRepository } from '../db';
import { recordAuthEvent } from './audit';
import { resolveDeps, type AuthDeps, type AuthRequest } from './context';
import { AuthError } from './errors';
import { enforceRateLimit } from './rate-limit';
import { generateRecoveryCodes, hashRecoveryCode, RECOVERY_CODE_COUNT } from './recovery-codes';
import { issueSession, revokeToken, type AuthSession, type IssuedSession } from './sessions';

const INVALID = "That code didn't work. Check it and try again.";

export async function redeemRecoveryCode(
	code: unknown,
	presentedToken: string | undefined,
	request: AuthRequest,
	deps: AuthDeps = {}
): Promise<IssuedSession & { remaining: number }> {
	const { db, now } = resolveDeps(deps);
	await enforceRateLimit('recovery', { ip: request.ip }, request, { db, now });
	await enforceRateLimit('recovery.global', 'global', request, { db, now });

	const hash = typeof code === 'string' && code.length <= 64 ? hashRecoveryCode(code) : null;
	const result = hash
		? await db.transaction(async (tx) => {
				const repo = createAuthRepository(tx);
				const ownerId = await repo.burnRecoveryCode(hash, now());
				if (!ownerId) return null;
				await revokeToken(presentedToken, 'rotated', { db: tx, now });
				const issued = await issueSession(
					{ ownerId, kind: 'recovery', method: 'recovery', userAgent: request.userAgent },
					{ db: tx, now }
				);
				const { unused } = await repo.recoveryCodeStatus(ownerId);
				return { ...issued, ownerId, remaining: unused };
			})
		: null;

	if (!result) {
		await recordAuthEvent(db, request, {
			type: 'recovery.failed',
			detail: { malformed: hash === null }
		});
		throw new AuthError('invalid_code', INVALID);
	}
	await recordAuthEvent(db, request, {
		type: 'recovery.used',
		ownerId: result.ownerId,
		sessionId: result.session.id,
		detail: { remaining: result.remaining }
	});
	return { token: result.token, session: result.session, remaining: result.remaining };
}

export async function recoveryCodeStatus(
	session: AuthSession,
	deps: AuthDeps = {}
): Promise<{ total: number; unused: number }> {
	const { db } = resolveDeps(deps);
	return createAuthRepository(db).recoveryCodeStatus(session.ownerId);
}

/** Replace every recovery code with a fresh set; the plain codes are returned once. */
export async function regenerateRecoveryCodes(
	session: AuthSession,
	request: AuthRequest,
	deps: AuthDeps = {}
): Promise<string[]> {
	const { db, now } = resolveDeps(deps);
	if (session.kind !== 'owner') {
		throw new AuthError('invalid_input', 'Add a passkey before creating new recovery codes.');
	}
	await enforceRateLimit('manage', { session: session.id }, request, { db, now });
	const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
	await db.transaction((tx) =>
		createAuthRepository(tx).replaceRecoveryCodes(
			session.ownerId,
			codes.map((c) => hashRecoveryCode(c)!),
			now()
		)
	);
	await recordAuthEvent(db, request, {
		type: 'recovery.regenerated',
		ownerId: session.ownerId,
		sessionId: session.id
	});
	return codes;
}
