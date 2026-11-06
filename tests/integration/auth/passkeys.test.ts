import { describe, expect, it } from 'vitest';
import { createAuthRepository } from '../../../src/lib/server/db';
import {
	beginPasskeyRegistration,
	beginSignIn,
	completePasskeyRegistration,
	completeSignIn,
	listPasskeys,
	removePasskey,
	renamePasskey
} from '../../../src/lib/server/auth/passkeys';
import { setupOpen } from '../../../src/lib/server/auth/setup';
import { mintTestSession } from '../../../src/lib/server/auth/test-support';
import {
	issueSession,
	revokeSession,
	validateSessionToken
} from '../../../src/lib/server/auth/sessions';
import { holdTransaction, lockWaiters, withCommitted, withRollback } from '../helpers';
import { ORIGIN, request, RP, setUpOwner, UA } from './fixtures';
import { SoftAuthenticator } from './soft-authenticator';

describe('passkey management', () => {
	it('adds a second passkey that can sign in, and refuses registering one twice', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			const session = (await validateSessionToken(owner.token, { db: tx }))!.session;
			const laptop = new SoftAuthenticator({ rpId: RP.rpID, origin: ORIGIN });
			const options = await beginPasskeyRegistration(session, request(), { db: tx });
			expect(options.user).toMatchObject({
				id: owner.registrationOptions.user.id,
				name: 'Niko Cruz'
			});
			expect(options.authenticatorSelection).toMatchObject({
				residentKey: 'required',
				userVerification: 'required'
			});

			const added = await completePasskeyRegistration(
				session,
				laptop.register(options),
				request(),
				{ db: tx }
			);
			expect(added.upgradedSession).toBeUndefined();
			expect((await listPasskeys(session, { db: tx })).map((p) => p.id)).toEqual([
				owner.authenticator.id,
				laptop.id
			]);

			const signIn = await beginSignIn(request(), { db: tx });
			await expect(
				completeSignIn(laptop.assert(signIn), undefined, request(), { db: tx })
			).resolves.toMatchObject({
				session: { credentialId: laptop.id }
			});

			const again = await beginPasskeyRegistration(session, request(), { db: tx });
			await expect(
				completePasskeyRegistration(session, laptop.register(again), request(), { db: tx })
			).rejects.toMatchObject({ code: 'already_registered' });
		});
	});

	it('binds a registration challenge to the session that asked for it', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			const session = (await validateSessionToken(owner.token, { db: tx }))!.session;
			const other = await mintTestSession(request(), { db: tx, enabled: true });
			const otherSession = (await validateSessionToken(other.token, { db: tx }))!.session;
			const options = await beginPasskeyRegistration(session, request(), { db: tx });
			const key = new SoftAuthenticator({ rpId: RP.rpID, origin: ORIGIN });
			await expect(
				completePasskeyRegistration(otherSession, key.register(options), request(), { db: tx })
			).rejects.toMatchObject({ code: 'challenge_invalid' });
		});
	});

	it('adds nothing for a session revoked after its request was validated', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			const session = (await validateSessionToken(owner.token, { db: tx }))!.session;
			// Fresh (it has just used a passkey), so it may start a registration (step-up).
			const stolen = await issueSession(
				{ ownerId: owner.ownerId, method: 'passkey', userAgent: UA, reauthenticated: true },
				{ db: tx }
			);
			const stolenSession = (await validateSessionToken(stolen.token, { db: tx }))!.session;
			const key = new SoftAuthenticator({ rpId: RP.rpID, origin: ORIGIN });
			const options = await beginPasskeyRegistration(stolenSession, request(), { db: tx });

			await revokeSession(session, stolenSession.id, request(), { db: tx });
			await expect(
				completePasskeyRegistration(stolenSession, key.register(options), request(), { db: tx })
			).rejects.toMatchObject({ code: 'not_found' });
			expect(await createAuthRepository(tx).countPasskeys(owner.ownerId)).toBe(1);
		});
	});

	it('waits for a revocation in progress, then adds nothing', async () => {
		await withCommitted(async (db) => {
			const owner = await setUpOwner(db);
			const session = (await validateSessionToken(owner.token, { db }))!.session;
			const stolen = await issueSession(
				{ ownerId: owner.ownerId, method: 'passkey', userAgent: UA, reauthenticated: true },
				{ db }
			);
			const stolenSession = (await validateSessionToken(stolen.token, { db }))!.session;
			const key = new SoftAuthenticator({ rpId: RP.rpID, origin: ORIGIN });
			const options = await beginPasskeyRegistration(stolenSession, request(), { db });

			// The owner's revocation has updated the row but not committed when the stolen
			// session's request reaches its transaction.
			const revocation = await holdTransaction((tx) =>
				revokeSession(session, stolenSession.id, request(), { db: tx })
			);
			const adding = completePasskeyRegistration(stolenSession, key.register(options), request(), {
				db
			});
			await lockWaiters(1);
			await revocation.commit();

			await expect(adding).rejects.toMatchObject({ code: 'not_found' });
			expect(await createAuthRepository(db).countPasskeys(owner.ownerId)).toBe(1);
		});
	});

	it('renames (validated) and removes — never the last passkey', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			const session = (await validateSessionToken(owner.token, { db: tx }))!.session;
			const id = owner.authenticator.id;

			expect(await renamePasskey(session, id, '  iPhone   15 Pro ', request(), { db: tx })).toBe(
				'iPhone 15 Pro'
			);
			for (const bad of ['', '   ', 'x'.repeat(65), null]) {
				await expect(renamePasskey(session, id, bad, request(), { db: tx })).rejects.toMatchObject({
					code: 'invalid_input'
				});
			}
			await expect(
				renamePasskey(session, 'missing', 'X', request(), { db: tx })
			).rejects.toMatchObject({ code: 'not_found' });

			await expect(removePasskey(session, id, request(), { db: tx })).rejects.toMatchObject({
				code: 'last_passkey',
				status: 409
			});
			expect(await createAuthRepository(tx).countPasskeys()).toBe(1);
		});
	});

	it('answers a malformed passkey id as not found, never with a database error', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			const session = (await validateSessionToken(owner.token, { db: tx }))!.session;
			// Credential ids are base64url; a NUL byte is one Postgres cannot even compare.
			for (const bad of ['', 'not base64url!', `${owner.authenticator.id}\u0000`]) {
				await expect(renamePasskey(session, bad, 'X', request(), { db: tx })).rejects.toMatchObject(
					{ code: 'not_found', status: 404 }
				);
				await expect(removePasskey(session, bad, request(), { db: tx })).rejects.toMatchObject({
					code: 'not_found',
					status: 404
				});
			}
			expect(await listPasskeys(session, { db: tx })).toHaveLength(1);
		});
	});

	it('removing a passkey signs out the other devices that used it', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			const session = (await validateSessionToken(owner.token, { db: tx }))!.session;
			const lost = new SoftAuthenticator({ rpId: RP.rpID, origin: ORIGIN });
			await completePasskeyRegistration(
				session,
				lost.register(await beginPasskeyRegistration(session, request(), { db: tx })),
				request(),
				{ db: tx }
			);
			const thief = await completeSignIn(
				lost.assert(await beginSignIn(request(), { db: tx })),
				undefined,
				request(),
				{ db: tx }
			);

			expect(await removePasskey(session, lost.id, request(), { db: tx })).toEqual({
				endedSessions: 1
			});
			expect(await validateSessionToken(thief.token, { db: tx })).toBeNull();
			expect(await validateSessionToken(owner.token, { db: tx })).not.toBeNull();
			await expect(
				completeSignIn(
					lost.assert(await beginSignIn(request(), { db: tx })),
					undefined,
					request(),
					{ db: tx }
				)
			).rejects.toMatchObject({ code: 'unknown_credential' });
		});
	});

	it('test-only sessions exist only when test routes are enabled', async () => {
		await withRollback(async (tx) => {
			await expect(mintTestSession(request(), { db: tx, enabled: false })).rejects.toMatchObject({
				code: 'not_found'
			});
			// Without an owner: a placeholder owner with no passkey, so setup stays open.
			const placeholder = await mintTestSession(request(), { db: tx, enabled: true });
			expect(placeholder.session).toMatchObject({ kind: 'owner', method: 'test' });
			expect(await setupOpen({ db: tx })).toBe(true);
			const owner = await setUpOwner(tx);
			expect(owner.ownerId).toBe(placeholder.session.ownerId);
			const minted = await mintTestSession(request(), { db: tx, enabled: true });
			expect(minted.session.ownerId).toBe(owner.ownerId);
		});
	});
});
