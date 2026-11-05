import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createAuthRepository } from '../../../src/lib/server/db';
import {
	beginSetup,
	checkSetupAccess,
	completeSetup,
	setupOpen,
	setupTokenValid
} from '../../../src/lib/server/auth/setup';
import { hashRecoveryCode } from '../../../src/lib/server/auth/recovery-codes';
import { hashToken } from '../../../src/lib/server/auth/tokens';
import { resetOwnerAuth } from '../../../scripts/auth-reset-owner';
import { validateSessionToken } from '../../../src/lib/server/auth/sessions';
import type { Executor } from '../../../src/lib/server/db';
import { withRollback } from '../helpers';
import { ORIGIN, request, RP, SETUP_CONFIG, SETUP_TOKEN, setUpOwner } from './fixtures';
import { SoftAuthenticator } from './soft-authenticator';

const deps = (db: Parameters<typeof setUpOwner>[0]) => ({ db, config: SETUP_CONFIG });

describe('first-run setup', () => {
	it('accepts only the token whose SHA-256 is configured', () => {
		expect(setupTokenValid(SETUP_TOKEN, SETUP_CONFIG)).toBe(true);
		expect(setupTokenValid(`${SETUP_TOKEN}x`, SETUP_CONFIG)).toBe(false);
		expect(setupTokenValid(SETUP_CONFIG.tokenHash, SETUP_CONFIG)).toBe(false);
		expect(setupTokenValid(SETUP_TOKEN, {})).toBe(false); // not configured: setup closed
		expect(setupTokenValid(undefined, SETUP_CONFIG)).toBe(false);
	});

	it('creates the owner, the first passkey, 10 hashed recovery codes and a session', async () => {
		await withRollback(async (tx) => {
			expect(await setupOpen({ db: tx })).toBe(true);
			expect(await checkSetupAccess(SETUP_TOKEN, request(), deps(tx))).toBe(true);

			const result = await setUpOwner(tx);
			const repo = createAuthRepository(tx);
			const owner = await repo.getOwner();
			expect(owner).toMatchObject({ displayName: 'Niko Cruz', id: result.ownerId });
			expect(owner!.setupCompletedAt).toBeInstanceOf(Date);
			expect(owner!.webauthnUserId).toBe(result.registrationOptions.user.id);

			const [passkey] = await repo.listPasskeys(result.ownerId);
			expect(passkey).toMatchObject({
				id: result.authenticator.id,
				counter: 0,
				deviceType: 'multiDevice',
				backedUp: true,
				transports: ['internal', 'hybrid'],
				nickname: 'iPhone passkey'
			});
			expect(passkey!.publicKey).toBeInstanceOf(Uint8Array);
			expect(passkey!.publicKey.length).toBeGreaterThan(60);

			// 10 codes, shown once: only their hashes are stored.
			expect(result.recoveryCodes).toHaveLength(10);
			const stored = await tx.execute<{ code_hash: string }>(
				sql`select code_hash from recovery_codes where owner_id = ${result.ownerId}`
			);
			expect(stored.rows.map((r) => r.code_hash).sort()).toEqual(
				result.recoveryCodes.map((c) => hashRecoveryCode(c)).sort()
			);
			const dump = JSON.stringify(
				(await tx.execute(sql`select * from recovery_codes, auth_sessions`)).rows
			);
			for (const code of result.recoveryCodes) expect(dump).not.toContain(code);
			expect(dump).not.toContain(result.token);
			expect(dump).toContain(hashToken(result.token));

			expect(result.session).toMatchObject({ kind: 'owner', method: 'setup' });
			const events = await repo.recentEvents();
			expect(events.map((e) => e.type)).toContain('setup.completed');
		});
	});

	it('closes for good once the first passkey exists', async () => {
		await withRollback(async (tx) => {
			await setUpOwner(tx);
			expect(await setupOpen({ db: tx })).toBe(false);
			expect(await checkSetupAccess(SETUP_TOKEN, request(), deps(tx))).toBe(false);
			await expect(
				beginSetup({ token: SETUP_TOKEN, name: 'Intruder' }, request(), deps(tx))
			).rejects.toMatchObject({ code: 'setup_unavailable', status: 404 });
			// Not even a second, already-prepared ceremony can complete.
			await expect(setUpOwner(tx)).rejects.toMatchObject({ code: 'setup_unavailable' });
			expect(await createAuthRepository(tx).countPasskeys()).toBe(1);
		});
	});

	it('refuses a wrong token, and records the attempt', async () => {
		await withRollback(async (tx) => {
			expect(await checkSetupAccess('not-the-token-at-all', request(), deps(tx))).toBe(false);
			await expect(
				beginSetup({ token: 'not-the-token-at-all', name: 'Niko' }, request(), deps(tx))
			).rejects.toMatchObject({ code: 'setup_unavailable' });
			const events = await createAuthRepository(tx).recentEvents();
			expect(events.filter((e) => e.type === 'setup.failed')).toHaveLength(2);
			expect(await setupOpen({ db: tx })).toBe(true);
		});
	});

	it('requires a name of 1–64 characters', async () => {
		await withRollback(async (tx) => {
			for (const name of ['', '   ', 'x'.repeat(65), 42]) {
				await expect(
					beginSetup({ token: SETUP_TOKEN, name }, request(), deps(tx))
				).rejects.toMatchObject({ code: 'invalid_input' });
			}
		});
	});

	it('rejects a passkey made for another origin, RP or without user verification', async () => {
		await withRollback(async (tx) => {
			const cases = [
				{ origin: 'https://evil.example' },
				{ rpId: 'coach.nikocruz.com' },
				{ userVerified: false },
				{ type: 'webauthn.get' }
			];
			for (const overrides of cases) {
				const opts = await beginSetup({ token: SETUP_TOKEN, name: 'Niko' }, request(), deps(tx));
				const authenticator = new SoftAuthenticator({ rpId: RP.rpID, origin: ORIGIN });
				await expect(
					completeSetup(
						{ token: SETUP_TOKEN, response: authenticator.register(opts, overrides) },
						undefined,
						request(),
						deps(tx)
					),
					JSON.stringify(overrides)
				).rejects.toMatchObject({ code: 'verification_failed' });
			}
			expect(await setupOpen({ db: tx })).toBe(true);
		});
	});

	it('uses each challenge once', async () => {
		await withRollback(async (tx) => {
			const opts = await beginSetup({ token: SETUP_TOKEN, name: 'Niko' }, request(), deps(tx));
			const authenticator = new SoftAuthenticator({ rpId: RP.rpID, origin: ORIGIN });
			const forged = authenticator.register(opts, { challenge: 'bm90LWlzc3VlZA' });
			await expect(
				completeSetup({ token: SETUP_TOKEN, response: forged }, undefined, request(), deps(tx))
			).rejects.toMatchObject({ code: 'challenge_invalid' });
			const response = authenticator.register(opts);
			await completeSetup({ token: SETUP_TOKEN, response }, undefined, request(), deps(tx));
			await expect(
				completeSetup({ token: SETUP_TOKEN, response }, undefined, request(), deps(tx))
			).rejects.toMatchObject({ code: 'setup_unavailable' });
		});
	});

	it('reopens after `pnpm auth:reset-owner`, keeping the owner (and their data)', async () => {
		await withRollback(async (tx) => {
			const first = await setUpOwner(tx);
			// The transaction's own connection: the script's statements join this rolled-back test.
			const client = (tx as Executor & { session: { client: import('pg').PoolClient } }).session
				.client;
			const summary = await resetOwnerAuth(client, { transaction: false });
			expect(summary).toEqual({
				ownerName: 'Niko Cruz',
				passkeys: 1,
				sessions: 1,
				recoveryCodes: 10
			});

			expect(await validateSessionToken(first.token, { db: tx })).toBeNull();
			expect(await setupOpen({ db: tx })).toBe(true);
			const [reset] = await createAuthRepository(tx).recentEvents(1);
			expect(reset).toMatchObject({ type: 'owner.reset', ownerId: first.ownerId });

			// Setup runs again and re-attaches the same owner with a new passkey and new codes.
			const second = await setUpOwner(tx, { name: 'Niko' });
			expect(second.ownerId).toBe(first.ownerId);
			expect(await createAuthRepository(tx).listPasskeys(first.ownerId)).toHaveLength(1);
			expect(second.recoveryCodes.some((c) => first.recoveryCodes.includes(c))).toBe(false);
			expect(await setupOpen({ db: tx })).toBe(false);
		});
	});
});
