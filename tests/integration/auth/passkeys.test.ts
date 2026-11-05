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
import { mintTestSession } from '../../../src/lib/server/auth/test-support';
import { validateSessionToken } from '../../../src/lib/server/auth/sessions';
import { withRollback } from '../helpers';
import { ORIGIN, request, RP, setUpOwner } from './fixtures';
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

	it('test-only sessions exist only when test routes are enabled, and only for an owner', async () => {
		await withRollback(async (tx) => {
			await expect(mintTestSession(request(), { db: tx, enabled: false })).rejects.toMatchObject({
				code: 'not_found'
			});
			await expect(mintTestSession(request(), { db: tx, enabled: true })).rejects.toMatchObject({
				code: 'not_found'
			});
			await setUpOwner(tx);
			const minted = await mintTestSession(request(), { db: tx, enabled: true });
			expect(minted.session).toMatchObject({ kind: 'owner', method: 'test' });
		});
	});
});
