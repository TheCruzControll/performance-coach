import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createAuthRepository } from '../../../src/lib/server/db';
import {
	beginPasskeyRegistration,
	completePasskeyRegistration
} from '../../../src/lib/server/auth/passkeys';
import {
	recoveryCodeStatus,
	redeemRecoveryCode,
	regenerateRecoveryCodes
} from '../../../src/lib/server/auth/recovery';
import { SESSION } from '../../../src/lib/server/auth/policy';
import { validateSessionToken } from '../../../src/lib/server/auth/sessions';
import { withRollback } from '../helpers';
import { clock, ORIGIN, request, RP, setUpOwner } from './fixtures';
import { SoftAuthenticator } from './soft-authenticator';

describe('recovery codes', () => {
	it('sign in once each, into a restricted 15-minute session', async () => {
		await withRollback(async (tx) => {
			const time = clock();
			const owner = await setUpOwner(tx, { now: time.now });
			const [code] = owner.recoveryCodes;

			const recovered = await redeemRecoveryCode(code, owner.token, request(), {
				db: tx,
				now: time.now
			});
			expect(recovered.session).toMatchObject({ kind: 'recovery', method: 'recovery' });
			expect(recovered.session.absoluteExpiresAt.getTime()).toBe(
				time.now().getTime() + SESSION.recoveryMs
			);
			expect(recovered.remaining).toBe(9);
			// Rotation: the session the device presented is gone.
			expect(await validateSessionToken(owner.token, { db: tx, now: time.now })).toBeNull();

			const burned = await tx.execute<{ used: number }>(
				sql`select count(*)::int as used from recovery_codes where used_at is not null`
			);
			expect(burned.rows[0]!.used).toBe(1);

			// Burned: the same code never works again, in any spelling.
			for (const again of [code, code!.toLowerCase(), code!.replace(/-/g, ' ')]) {
				await expect(
					redeemRecoveryCode(again, undefined, request(), { db: tx, now: time.now })
				).rejects.toMatchObject({ code: 'invalid_code', status: 401 });
			}

			time.advance(SESSION.recoveryMs + 1_000);
			expect(await validateSessionToken(recovered.token, { db: tx, now: time.now })).toBeNull();
			const types = (await createAuthRepository(tx).recentEvents(10)).map((e) => e.type);
			expect(types).toEqual(expect.arrayContaining(['recovery.used', 'recovery.failed']));
		});
	});

	it('refuse unknown and malformed codes without saying which', async () => {
		await withRollback(async (tx) => {
			await setUpOwner(tx);
			for (const bad of ['AAAA-AAAA-AAAA-AAAA', 'nope', '', 42, null]) {
				await expect(
					redeemRecoveryCode(bad, undefined, request(), { db: tx })
				).rejects.toMatchObject({
					code: 'invalid_code',
					message: "That code didn't work. Check it and try again."
				});
			}
		});
	});

	it('force a new passkey, which rotates the recovery session into a full one', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			const recovered = await redeemRecoveryCode(owner.recoveryCodes[3], undefined, request(), {
				db: tx
			});
			const session = (await validateSessionToken(recovered.token, { db: tx }))!.session;
			expect(session.kind).toBe('recovery');

			// A recovery session cannot mint new codes.
			await expect(regenerateRecoveryCodes(session, request(), { db: tx })).rejects.toMatchObject({
				code: 'invalid_input'
			});

			const replacement = new SoftAuthenticator({ rpId: RP.rpID, origin: ORIGIN });
			const options = await beginPasskeyRegistration(session, request(), { db: tx });
			expect(options.excludeCredentials?.map((c) => c.id)).toEqual([owner.authenticator.id]);
			const added = await completePasskeyRegistration(
				session,
				replacement.register(options),
				request(),
				{ db: tx }
			);

			expect(added.upgradedSession?.session).toMatchObject({
				kind: 'owner',
				method: 'recovery',
				credentialId: replacement.id
			});
			expect(await validateSessionToken(recovered.token, { db: tx })).toBeNull();
			expect(
				(await validateSessionToken(added.upgradedSession!.token, { db: tx }))?.session.kind
			).toBe('owner');
			expect(await createAuthRepository(tx).countPasskeys(owner.ownerId)).toBe(2);
		});
	});

	it('regenerate: every old code stops working, 10 new ones do', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			const session = (await validateSessionToken(owner.token, { db: tx }))!.session;
			await redeemRecoveryCode(owner.recoveryCodes[0], undefined, request(), { db: tx });
			expect(await recoveryCodeStatus(session, { db: tx })).toEqual({ total: 10, unused: 9 });

			const fresh = await regenerateRecoveryCodes(session, request(), { db: tx });
			expect(fresh).toHaveLength(10);
			expect(fresh.some((c) => owner.recoveryCodes.includes(c))).toBe(false);
			expect(await recoveryCodeStatus(session, { db: tx })).toEqual({ total: 10, unused: 10 });

			await expect(
				redeemRecoveryCode(owner.recoveryCodes[1], undefined, request(), { db: tx })
			).rejects.toMatchObject({ code: 'invalid_code' });
			await expect(
				redeemRecoveryCode(fresh[9], undefined, request(), { db: tx })
			).resolves.toMatchObject({ remaining: 9 });
		});
	});
});
