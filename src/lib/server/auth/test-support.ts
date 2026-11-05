/**
 * Test-only session minting, for browsers without a WebAuthn virtual authenticator (WebKit e2e).
 * Reachable only through `/api/test-support/session`, which exists only when test routes are
 * enabled *and* allowed (`testRoutesEnabled()`: local development and tests, never a hosted
 * deployment — env validation refuses to start otherwise). Chromium e2e never uses it: it signs
 * in with real WebAuthn ceremonies.
 */
import { createAuthRepository } from '../db';
import { testRoutesEnabled } from '../env';
import { resolveDeps, type AuthDeps, type AuthRequest } from './context';
import { AuthError } from './errors';
import { issueSession, type IssuedSession } from './sessions';

export async function mintTestSession(
	request: AuthRequest,
	deps: AuthDeps & { enabled?: boolean } = {}
): Promise<IssuedSession> {
	if (!(deps.enabled ?? testRoutesEnabled())) throw new AuthError('not_found', 'Not found');
	const { db, now } = resolveDeps(deps);
	const owner = await createAuthRepository(db).getOwner();
	if (!owner) throw new AuthError('not_found', 'No owner yet: complete setup first.');
	return issueSession(
		{ ownerId: owner.id, method: 'test', userAgent: request.userAgent },
		{ db, now }
	);
}
