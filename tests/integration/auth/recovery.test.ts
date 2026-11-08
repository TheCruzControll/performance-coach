import { createHash } from 'node:crypto';
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
import {
	listSessions,
	revokeOtherSessions,
	validateSessionToken
} from '../../../src/lib/server/auth/sessions';
import { holdTransaction, lockWaiters, withCommitted, withRollback } from '../helpers';
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

	it('a recovery session revoked mid-request adds no passkey and gets no full session', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			const ownerSession = (await validateSessionToken(owner.token, { db: tx }))!.session;
			// Someone else redeems a stolen code and starts adding their own passkey.
			const recovered = await redeemRecoveryCode(owner.recoveryCodes[4], undefined, request(), {
				db: tx
			});
			const session = (await validateSessionToken(recovered.token, { db: tx }))!.session;
			const intruder = new SoftAuthenticator({ rpId: RP.rpID, origin: ORIGIN });
			const options = await beginPasskeyRegistration(session, request(), { db: tx });

			// The guard has validated their verify request when the owner signs out everywhere else.
			expect(await revokeOtherSessions(ownerSession, request(), { db: tx })).toBe(1);
			await expect(
				completePasskeyRegistration(session, intruder.register(options), request(), { db: tx })
			).rejects.toMatchObject({ code: 'not_found' });

			expect(await createAuthRepository(tx).countPasskeys(owner.ownerId)).toBe(1);
			expect((await listSessions(ownerSession, { db: tx })).map((s) => s.id)).toEqual([
				ownerSession.id
			]);
		});
	});

	it('sign out everywhere else arriving during the upgrade also ends the upgraded session', async () => {
		await withCommitted(async (db) => {
			const owner = await setUpOwner(db);
			const ownerSession = (await validateSessionToken(owner.token, { db }))!.session;
			const recovered = await redeemRecoveryCode(owner.recoveryCodes[5], undefined, request(), {
				db
			});
			const session = (await validateSessionToken(recovered.token, { db }))!.session;
			const intruder = new SoftAuthenticator({ rpId: RP.rpID, origin: ORIGIN });
			const options = await beginPasskeyRegistration(session, request(), { db });

			// Pause the upgrade inside its transaction, after it has locked the recovery session:
			// holding the owner row makes its first insert wait at the foreign-key check.
			const pause = await holdTransaction((tx) =>
				tx.execute(sql`select id from owners for update`)
			);
			const upgrading = completePasskeyRegistration(
				session,
				intruder.register(options),
				request(),
				{ db }
			);
			await lockWaiters(1);
			// The owner signs out everywhere else while the upgrade is in its transaction.
			const signingOut = revokeOtherSessions(ownerSession, request(), { db });
			await lockWaiters(2);
			await pause.commit();

			// The upgrade came first, so it completes; the sign-out then ends the session it made.
			const upgraded = await upgrading;
			expect(upgraded.upgradedSession).toBeDefined();
			expect(await signingOut).toBe(1);
			expect(await validateSessionToken(upgraded.upgradedSession!.token, { db })).toBeNull();
			expect((await listSessions(ownerSession, { db })).map((s) => s.id)).toEqual([
				ownerSession.id
			]);
		});
	});

	it('a recovery session that expires mid-request adds no passkey', async () => {
		await withRollback(async (tx) => {
			const time = clock();
			const owner = await setUpOwner(tx, { now: time.now });
			const recovered = await redeemRecoveryCode(owner.recoveryCodes[6], undefined, request(), {
				db: tx,
				now: time.now
			});
			time.advance(SESSION.recoveryMs - 60_000);
			const session = (await validateSessionToken(recovered.token, { db: tx, now: time.now }))!
				.session;
			const intruder = new SoftAuthenticator({ rpId: RP.rpID, origin: ORIGIN });
			const options = await beginPasskeyRegistration(session, request(), {
				db: tx,
				now: time.now
			});

			// The guard let the request in a minute before the session's 15 minutes ran out; it
			// reaches its transaction a second after (the challenge itself is still valid).
			time.advance(61_000);
			await expect(
				completePasskeyRegistration(session, intruder.register(options), request(), {
					db: tx,
					now: time.now
				})
			).rejects.toMatchObject({ code: 'not_found' });
			expect(await createAuthRepository(tx).countPasskeys(owner.ownerId)).toBe(1);
		});
	});

	it('a recovery session that expires while its request waits for the session lock adds no passkey', async () => {
		await withCommitted(async (db) => {
			const time = clock();
			const owner = await setUpOwner(db, { now: time.now });
			const recovered = await redeemRecoveryCode(owner.recoveryCodes[7], undefined, request(), {
				db,
				now: time.now
			});
			time.advance(SESSION.recoveryMs - 60_000);
			const session = (await validateSessionToken(recovered.token, { db, now: time.now }))!.session;
			const intruder = new SoftAuthenticator({ rpId: RP.rpID, origin: ORIGIN });
			const options = await beginPasskeyRegistration(session, request(), { db, now: time.now });

			// Another request holds the recovery session's row when this one reaches its transaction,
			// and the session's 15 minutes run out while it waits.
			const other = await holdTransaction((tx) =>
				tx.execute(sql`select id from auth_sessions where id = ${session.id} for update`)
			);
			const adding = completePasskeyRegistration(session, intruder.register(options), request(), {
				db,
				now: time.now
			});
			// Expect the refusal before awaiting anything else: the request can fail as soon as the
			// lock is released, before other.commit() returns, and must not reject unobserved.
			const refused = expect(adding).rejects.toMatchObject({ code: 'not_found' });
			await lockWaiters(1);
			time.advance(61_000);
			await other.commit();

			await refused;
			expect(await createAuthRepository(db).countPasskeys(owner.ownerId)).toBe(1);
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

const SIX_GROUPS = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/;

describe('120-bit recovery codes (ASVS 2.6.2)', () => {
	it('setup and regeneration issue 24-character codes, and a used one is refused in any spelling', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			for (const code of owner.recoveryCodes) expect(code).toMatch(SIX_GROUPS);
			const session = (await validateSessionToken(owner.token, { db: tx }))!.session;

			const fresh = await regenerateRecoveryCodes(session, request(), { db: tx });
			expect(fresh).toHaveLength(10);
			for (const code of fresh) {
				expect(code).toMatch(SIX_GROUPS);
				expect(code.replace(/-/g, '')).toHaveLength(24);
			}

			// Typed the forgiving way: lower case, spaces for dashes.
			const code = fresh[2]!;
			await expect(
				redeemRecoveryCode(code.toLowerCase().replace(/-/g, ' '), undefined, request(), {
					db: tx
				})
			).resolves.toMatchObject({ remaining: 9 });
			for (const again of [code, code.toLowerCase(), code.replace(/-/g, ''), ` ${code} `]) {
				await expect(
					redeemRecoveryCode(again, undefined, request(), { db: tx }),
					again
				).rejects.toMatchObject({ code: 'invalid_code', status: 401 });
			}
		});
	});

	it('a legacy 16-character code saved before the change signs in exactly once', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			// The owner's set as it was stored before: SHA-256 of the prefixed, normalised 80-bit code.
			const legacy = ['7KQ2-M9XD-4TPA-HC3R', 'W8NB-5FJE-0123-4567'];
			const stored = legacy.map((code) =>
				createHash('sha256')
					.update(`recovery:${code.replace(/-/g, '')}`, 'utf8')
					.digest('hex')
			);
			await createAuthRepository(tx).replaceRecoveryCodes(owner.ownerId, stored, new Date());

			const recovered = await redeemRecoveryCode('7kq2 m9xd 4tpa hc3r', undefined, request(), {
				db: tx
			});
			expect(recovered).toMatchObject({
				remaining: 1,
				session: { kind: 'recovery', method: 'recovery' }
			});
			for (const again of [legacy[0]!, '7KQ2M9XD4TPAHC3R']) {
				await expect(
					redeemRecoveryCode(again, undefined, request(), { db: tx }),
					again
				).rejects.toMatchObject({ code: 'invalid_code' });
			}
			const burned = await tx.execute<{ used: number }>(
				sql`select count(*)::int as used from recovery_codes where used_at is not null`
			);
			expect(burned.rows[0]!.used).toBe(1);
		});
	});
});
