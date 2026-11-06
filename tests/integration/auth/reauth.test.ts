import { describe, expect, it } from 'vitest';
import { createAuthRepository, type Executor } from '../../../src/lib/server/db';
import {
	beginPasskeyRegistration,
	beginSignIn,
	completePasskeyRegistration,
	completeSignIn,
	removePasskey,
	renamePasskey
} from '../../../src/lib/server/auth/passkeys';
import { RATE_LIMITS, SESSION } from '../../../src/lib/server/auth/policy';
import {
	beginReauthentication,
	completeReauthentication
} from '../../../src/lib/server/auth/reauth';
import { redeemRecoveryCode, regenerateRecoveryCodes } from '../../../src/lib/server/auth/recovery';
import {
	issueSession,
	revokeOtherSessions,
	revokeSession,
	validateSessionToken
} from '../../../src/lib/server/auth/sessions';
import { mintTestSession } from '../../../src/lib/server/auth/test-support';
import { withRollback } from '../helpers';
import { clock, ORIGIN, request, RP, setUpOwner, UA } from './fixtures';
import { SoftAuthenticator } from './soft-authenticator';

const MINUTE = 60_000;

/** An owner whose setup session went stale (6 minutes without a passkey). */
async function staleOwner(tx: Executor) {
	const time = clock();
	const deps = { db: tx, now: time.now };
	const owner = await setUpOwner(tx, { now: time.now });
	time.advance(6 * MINUTE);
	const session = async (token = owner.token) => (await validateSessionToken(token, deps))!.session;
	return { ...owner, setupAt: owner.session.createdAt, time, deps, session };
}

describe('step-up re-authentication', () => {
	it('a session that has not used a passkey for 5 minutes cannot take over the account', async () => {
		await withRollback(async (tx) => {
			const time = clock();
			const deps = { db: tx, now: time.now };
			const owner = await setUpOwner(tx, { now: time.now });
			const session = async () => (await validateSessionToken(owner.token, deps))!.session;
			// A second passkey and another device, so every action below would otherwise succeed.
			const spare = new SoftAuthenticator({ rpId: RP.rpID, origin: ORIGIN });
			await completePasskeyRegistration(
				await session(),
				spare.register(await beginPasskeyRegistration(await session(), request(), deps)),
				request(),
				deps
			);
			const phone = await issueSession(
				{ ownerId: owner.ownerId, method: 'passkey', userAgent: UA },
				deps
			);

			// Someone holding a copy of the cookie, 6 minutes after the owner last used a passkey.
			time.advance(6 * MINUTE);
			const stale = await session();
			const refused = { code: 'reauth_required', status: 403 };
			await expect(beginPasskeyRegistration(stale, request(), deps)).rejects.toMatchObject(refused);
			await expect(removePasskey(stale, spare.id, request(), deps)).rejects.toMatchObject(refused);
			await expect(regenerateRecoveryCodes(stale, request(), deps)).rejects.toMatchObject(refused);
			await expect(revokeSession(stale, phone.session.id, request(), deps)).rejects.toMatchObject(
				refused
			);
			await expect(revokeOtherSessions(stale, request(), deps)).rejects.toMatchObject(refused);

			// Nothing changed.
			const repo = createAuthRepository(tx);
			expect(await repo.countPasskeys(owner.ownerId)).toBe(2);
			expect(await validateSessionToken(phone.token, deps)).not.toBeNull();
			expect(await repo.recoveryCodeStatus(owner.ownerId)).toEqual({ total: 10, unused: 10 });

			// Renaming changes no credential, session or secret: it needs no step-up.
			await expect(renamePasskey(stale, spare.id, 'Spare key', request(), deps)).resolves.toBe(
				'Spare key'
			);
		});
	});

	it('a passkey sign-in, setup or the passkey that ends a recovery starts a fresh session; nothing else does', async () => {
		await withRollback(async (tx) => {
			const time = clock();
			const deps = { db: tx, now: time.now };
			const owner = await setUpOwner(tx, { now: time.now });
			expect(owner.session.reauthenticatedAt).toEqual(time.now());

			// The boundary: still fresh at exactly 5 minutes, refused just after.
			time.advance(SESSION.reauthMs);
			const atLimit = (await validateSessionToken(owner.token, deps))!.session;
			await expect(regenerateRecoveryCodes(atLimit, request(), deps)).resolves.toHaveLength(10);
			time.advance(1);
			await expect(regenerateRecoveryCodes(atLimit, request(), deps)).rejects.toMatchObject({
				code: 'reauth_required'
			});

			const signIn = await completeSignIn(
				owner.authenticator.assert(await beginSignIn(request(), deps)),
				undefined,
				request(),
				deps
			);
			expect(signIn.session.reauthenticatedAt).toEqual(time.now());

			const minted = await mintTestSession(request(), { ...deps, enabled: true });
			expect(minted.session.reauthenticatedAt).toBeNull();

			// Recovery: the code alone proves nothing about a passkey, but the session may still
			// register its new one (it has no other to confirm with). That passkey counts.
			const [code] = await regenerateRecoveryCodes(
				(await validateSessionToken(signIn.token, deps))!.session,
				request(),
				deps
			);
			const recovered = await redeemRecoveryCode(code, undefined, request(), deps);
			expect(recovered.session.reauthenticatedAt).toBeNull();
			const recovery = (await validateSessionToken(recovered.token, deps))!.session;
			const replacement = new SoftAuthenticator({ rpId: RP.rpID, origin: ORIGIN });
			const added = await completePasskeyRegistration(
				recovery,
				replacement.register(await beginPasskeyRegistration(recovery, request(), deps)),
				request(),
				deps
			);
			expect(added.upgradedSession!.session.reauthenticatedAt).toEqual(time.now());
			const upgraded = (await validateSessionToken(added.upgradedSession!.token, deps))!.session;
			// Removing the lost passkey right away needs no second prompt (it ends the setup and
			// sign-in sessions that used it).
			await expect(
				removePasskey(upgraded, owner.authenticator.id, request(), deps)
			).resolves.toEqual({ endedSessions: 2 });
		});
	});

	it('re-authenticating with one of the owner’s passkeys unlocks sensitive actions for 5 minutes', async () => {
		await withRollback(async (tx) => {
			const owner = await staleOwner(tx);
			const { deps, time } = owner;
			const stale = await owner.session();

			const options = await beginReauthentication(stale, request(), deps);
			expect(options.userVerification).toBe('required');
			expect(options.allowCredentials?.map((c) => c.id)).toEqual([owner.authenticator.id]);
			await expect(
				completeReauthentication(stale, owner.authenticator.assert(options), request(), deps)
			).resolves.toEqual({ reauthenticatedAt: time.now() });

			const fresh = await owner.session();
			expect(fresh.reauthenticatedAt).toEqual(time.now());
			await expect(regenerateRecoveryCodes(fresh, request(), deps)).resolves.toHaveLength(10);
			await expect(beginPasskeyRegistration(fresh, request(), deps)).resolves.toBeTruthy();

			time.advance(SESSION.reauthMs + 1);
			await expect(
				regenerateRecoveryCodes(await owner.session(), request(), deps)
			).rejects.toMatchObject({ code: 'reauth_required' });

			const repo = createAuthRepository(tx);
			expect((await repo.findPasskey(owner.authenticator.id))!.lastUsedAt).toEqual(
				fresh.reauthenticatedAt
			);
			const types = (await repo.recentEvents(10)).map((e) => e.type);
			expect(types).toContain('reauth.succeeded');
		});
	});

	it('accepts only a user-verified assertion, by an owner passkey, for this session’s challenge, once', async () => {
		await withRollback(async (tx) => {
			const owner = await staleOwner(tx);
			const { deps } = owner;
			const stale = await owner.session();
			const fails = async (response: unknown, code: string, session = stale) => {
				await expect(
					completeReauthentication(session, response, request(), deps)
				).rejects.toMatchObject({ code });
				expect((await owner.session()).reauthenticatedAt).toEqual(owner.setupAt);
			};

			// Face ID / Touch ID skipped (user presence only).
			await fails(
				owner.authenticator.assert(await beginReauthentication(stale, request(), deps), {
					userVerified: false
				}),
				'verification_failed'
			);
			// A passkey this account does not have.
			const stranger = new SoftAuthenticator({ rpId: RP.rpID, origin: ORIGIN });
			await fails(
				stranger.assert(await beginReauthentication(stale, request(), deps)),
				'unknown_credential'
			);
			// A challenge issued to another session, or for signing in.
			const other = await issueSession(
				{ ownerId: owner.ownerId, method: 'passkey', userAgent: UA, reauthenticated: true },
				deps
			);
			const otherSession = (await validateSessionToken(other.token, deps))!.session;
			await fails(
				owner.authenticator.assert(await beginReauthentication(otherSession, request(), deps)),
				'challenge_invalid'
			);
			await fails(
				owner.authenticator.assert(await beginSignIn(request(), deps)),
				'challenge_invalid'
			);
			// Replayed: a challenge works once.
			const response = owner.authenticator.assert(
				await beginReauthentication(stale, request(), deps)
			);
			await completeReauthentication(stale, response, request(), deps);
			await expect(
				completeReauthentication(stale, response, request(), deps)
			).rejects.toMatchObject({ code: 'challenge_invalid' });

			const failed = (await createAuthRepository(tx).recentEvents(20)).filter(
				(e) => e.type === 'reauth.failed'
			);
			expect(failed.map((e) => e.detail?.code)).toEqual(
				expect.arrayContaining(['verification_failed', 'unknown_credential', 'challenge_invalid'])
			);
		});
	});

	it('is for full owner sessions only, and rate-limited per session', async () => {
		await withRollback(async (tx) => {
			const owner = await staleOwner(tx);
			const { deps } = owner;
			const recovered = await redeemRecoveryCode(
				owner.recoveryCodes[0],
				undefined,
				request(),
				deps
			);
			const recovery = await owner.session(recovered.token);
			await expect(beginReauthentication(recovery, request(), deps)).rejects.toMatchObject({
				code: 'invalid_input'
			});

			const stale = await owner.session();
			for (let i = 0; i < RATE_LIMITS.reauth.limit; i++) {
				await beginReauthentication(stale, request(), deps);
			}
			await expect(beginReauthentication(stale, request(), deps)).rejects.toMatchObject({
				code: 'rate_limited',
				status: 429
			});
		});
	});
});
