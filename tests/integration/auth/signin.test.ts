import { describe, expect, it } from 'vitest';
import { createAuthRepository } from '../../../src/lib/server/db';
import { beginSignIn, completeSignIn } from '../../../src/lib/server/auth/passkeys';
import { validateSessionToken } from '../../../src/lib/server/auth/sessions';
import { withRollback } from '../helpers';
import { clock, ORIGIN, request, RP, setUpOwner } from './fixtures';
import { SoftAuthenticator } from './soft-authenticator';

describe('passkey sign-in', () => {
	it('verifies a real assertion, updates the counter and issues a new session', async () => {
		await withRollback(async (tx) => {
			const time = clock();
			const device = new SoftAuthenticator(
				{ rpId: RP.rpID, origin: ORIGIN },
				{ counter: 5, synced: false }
			);
			const owner = await setUpOwner(tx, { authenticator: device, now: time.now });
			time.advance(60_000);

			const options = await beginSignIn(request(), { db: tx, now: time.now });
			expect(options).toMatchObject({ rpId: 'localhost', userVerification: 'required' });
			expect(options.allowCredentials ?? []).toEqual([]); // discoverable credentials

			const issued = await completeSignIn(device.assert(options), undefined, request(), {
				db: tx,
				now: time.now
			});
			expect(issued.session).toMatchObject({
				ownerId: owner.ownerId,
				kind: 'owner',
				method: 'passkey',
				credentialId: device.id
			});
			const passkey = await createAuthRepository(tx).findPasskey(device.id);
			expect(passkey).toMatchObject({ counter: 6, deviceType: 'singleDevice', backedUp: false });
			expect(passkey!.lastUsedAt).toEqual(time.now());
			expect(await validateSessionToken(issued.token, { db: tx, now: time.now })).not.toBeNull();
			const events = await createAuthRepository(tx).recentEvents(1);
			expect(events[0]).toMatchObject({ type: 'signin.succeeded', credentialId: device.id });
		});
	});

	it('rotates: the session the device presented is revoked', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			const options = await beginSignIn(request(), { db: tx });
			const issued = await completeSignIn(
				owner.authenticator.assert(options),
				owner.token,
				request(),
				{ db: tx }
			);
			expect(issued.token).not.toBe(owner.token);
			expect(await validateSessionToken(owner.token, { db: tx })).toBeNull();
			expect(await createAuthRepository(tx).findSession(owner.session.id)).toMatchObject({
				revokedReason: 'rotated'
			});
		});
	});

	it('refuses a replayed assertion (single-use challenge)', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			const options = await beginSignIn(request(), { db: tx });
			const assertion = owner.authenticator.assert(options);
			await completeSignIn(assertion, undefined, request(), { db: tx });
			await expect(
				completeSignIn(assertion, undefined, request(), { db: tx })
			).rejects.toMatchObject({ code: 'challenge_invalid' });
		});
	});

	it('refuses an expired challenge', async () => {
		await withRollback(async (tx) => {
			const time = clock();
			const owner = await setUpOwner(tx, { now: time.now });
			const options = await beginSignIn(request(), { db: tx, now: time.now });
			time.advance(6 * 60_000);
			await expect(
				completeSignIn(owner.authenticator.assert(options), undefined, request(), {
					db: tx,
					now: time.now
				})
			).rejects.toMatchObject({ code: 'challenge_invalid' });
		});
	});

	it('refuses a signature counter that goes backwards (cloned authenticator)', async () => {
		await withRollback(async (tx) => {
			const device = new SoftAuthenticator(
				{ rpId: RP.rpID, origin: ORIGIN },
				{ counter: 10, synced: false }
			);
			await setUpOwner(tx, { authenticator: device });
			const first = await beginSignIn(request(), { db: tx });
			await completeSignIn(device.assert(first), undefined, request(), { db: tx }); // counter 11
			const second = await beginSignIn(request(), { db: tx });
			await expect(
				completeSignIn(device.assert(second, { counter: 3 }), undefined, request(), { db: tx })
			).rejects.toMatchObject({ code: 'verification_failed' });
			expect((await createAuthRepository(tx).findPasskey(device.id))!.counter).toBe(11);
			const [failed] = await createAuthRepository(tx).recentEvents(1);
			expect(failed).toMatchObject({ type: 'signin.failed', credentialId: device.id });
			expect(failed!.detail).toMatchObject({ code: 'verification_failed' });
		});
	});

	it('refuses unknown passkeys, other origins, the production RP and missing user verification', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			const stranger = new SoftAuthenticator({ rpId: RP.rpID, origin: ORIGIN });
			const unknown = await beginSignIn(request(), { db: tx });
			await expect(
				completeSignIn(stranger.assert(unknown), undefined, request(), { db: tx })
			).rejects.toMatchObject({ code: 'unknown_credential' });

			for (const overrides of [
				{ origin: 'https://evil.example' },
				{ origin: 'https://coach.nikocruz.com' },
				{ rpId: 'coach.nikocruz.com' },
				{ userVerified: false },
				{ type: 'webauthn.create' }
			]) {
				const options = await beginSignIn(request(), { db: tx });
				await expect(
					completeSignIn(owner.authenticator.assert(options, overrides), undefined, request(), {
						db: tx
					}),
					JSON.stringify(overrides)
				).rejects.toMatchObject({ code: 'verification_failed' });
			}
		});
	});

	it('rejects malformed bodies before they reach the verifier', async () => {
		await withRollback(async (tx) => {
			for (const body of [
				null,
				{},
				{ id: 'x' },
				{ id: '!!', rawId: '!!', type: 'public-key', response: {} }
			]) {
				await expect(completeSignIn(body, undefined, request(), { db: tx })).rejects.toMatchObject({
					code: 'invalid_input'
				});
			}
		});
	});
});
