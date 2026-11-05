/**
 * WebAuthn challenges: issued with the options, stored for a few minutes, consumed exactly once
 * for the purpose (and session) they were issued for. The challenge value comes back inside the
 * signed clientDataJSON, so it identifies its row; SimpleWebAuthn then verifies it matches.
 */
import { decodeClientDataJSON } from '@simplewebauthn/server/helpers';
import { createAuthRepository, type ChallengePurpose, type ChallengeRow } from '../db';
import { resolveDeps, type AuthDeps } from './context';
import { AuthError } from './errors';
import { CHALLENGE } from './policy';

export async function storeChallenge(
	input: {
		challenge: string;
		purpose: ChallengePurpose;
		rpId: string;
		sessionId?: string | null;
		data?: Record<string, unknown>;
	},
	deps: AuthDeps = {}
): Promise<ChallengeRow> {
	const { db, now } = resolveDeps(deps);
	const at = now();
	return createAuthRepository(db).insertChallenge(
		{
			challenge: input.challenge,
			purpose: input.purpose,
			rpId: input.rpId,
			sessionId: input.sessionId ?? null,
			data: input.data ?? null,
			createdAt: at,
			expiresAt: new Date(at.getTime() + CHALLENGE.ttlMs)
		},
		at
	);
}

/** The challenge a browser response claims to answer (unverified until SimpleWebAuthn checks). */
export function challengeOf(clientDataJSON: unknown): string | null {
	if (typeof clientDataJSON !== 'string' || clientDataJSON.length > 4096) return null;
	try {
		const { challenge } = decodeClientDataJSON(clientDataJSON);
		return typeof challenge === 'string' && challenge.length <= 256 ? challenge : null;
	} catch {
		return null;
	}
}

/**
 * Consume the challenge a response answers: it must exist, be unexpired, have been issued for
 * `purpose` on this RP ID and (for `register`) to this session. It is deleted either way.
 */
export async function consumeChallenge(
	clientDataJSON: unknown,
	expected: { purpose: ChallengePurpose; rpId: string; sessionId?: string },
	deps: AuthDeps = {}
): Promise<ChallengeRow> {
	const { db, now } = resolveDeps(deps);
	const value = challengeOf(clientDataJSON);
	const row = value
		? await createAuthRepository(db).consumeChallenge(value, expected.purpose, now())
		: null;
	if (
		!row ||
		row.rpId !== expected.rpId ||
		(expected.sessionId !== undefined && row.sessionId !== expected.sessionId)
	) {
		throw new AuthError(
			'challenge_invalid',
			'This sign-in request expired or was already used. Try again.'
		);
	}
	return row;
}
