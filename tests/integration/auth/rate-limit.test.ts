import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createAuthRepository } from '../../../src/lib/server/db';
import { beginSignIn, completeSignIn } from '../../../src/lib/server/auth/passkeys';
import { RATE_LIMIT_PRUNE, RATE_LIMITS } from '../../../src/lib/server/auth/policy';
import { enforceRateLimit } from '../../../src/lib/server/auth/rate-limit';
import { redeemRecoveryCode } from '../../../src/lib/server/auth/recovery';
import { signOut, validateSessionToken } from '../../../src/lib/server/auth/sessions';
import { checkSetupAccess } from '../../../src/lib/server/auth/setup';
import { withRollback } from '../helpers';
import { clock, request, SETUP_CONFIG, SETUP_TOKEN, setUpOwner } from './fixtures';

describe('DB-backed rate limits', () => {
	it('allow the limit, refuse the next hit with Retry-After, and reset with the window', async () => {
		await withRollback(async (tx) => {
			const time = clock();
			const deps = { db: tx, now: time.now };
			const client = request();
			const { limit, windowMs } = RATE_LIMITS['signin.verify'];
			for (let i = 0; i < limit; i++)
				await enforceRateLimit('signin.verify', { ip: client.ip }, client, deps);
			await expect(
				enforceRateLimit('signin.verify', { ip: client.ip }, client, deps)
			).rejects.toMatchObject({
				code: 'rate_limited',
				status: 429,
				retryAfter: windowMs / 1000
			});
			// Other clients and other buckets are unaffected.
			await enforceRateLimit('signin.verify', { ip: '203.0.113.99' }, client, deps);
			await enforceRateLimit('signin.options', { ip: client.ip }, client, deps);

			time.advance(windowMs + 1);
			await enforceRateLimit('signin.verify', { ip: client.ip }, client, deps);

			// The first refusal of a window is audited, not every one.
			const events = await createAuthRepository(tx).recentEvents(50);
			expect(events.filter((e) => e.type === 'rate_limited')).toHaveLength(1);
		});
	});

	it('count IPv6 clients per /64 and IPv4-mapped addresses as IPv4', async () => {
		await withRollback(async (tx) => {
			const deps = { db: tx };
			const client = request();
			const { limit } = RATE_LIMITS['signin.verify'];
			// A client rotating through its /64 (privacy addresses) shares one bucket.
			for (let i = 1; i <= limit; i++) {
				await enforceRateLimit('signin.verify', { ip: `2001:db8:1:2::${i}` }, client, deps);
			}
			await expect(
				enforceRateLimit('signin.verify', { ip: '2001:DB8:1:2:a:b:c:d' }, client, deps)
			).rejects.toMatchObject({ code: 'rate_limited' });
			// The neighbouring /64 is another network.
			await enforceRateLimit('signin.verify', { ip: '2001:db8:1:3::1' }, client, deps);

			// A dual-stack socket reports an IPv4 peer as `::ffff:a.b.c.d`: the same client.
			for (let i = 0; i < limit; i++) {
				await enforceRateLimit('signin.verify', { ip: '203.0.113.7' }, client, deps);
			}
			await expect(
				enforceRateLimit('signin.verify', { ip: '::ffff:203.0.113.7' }, client, deps)
			).rejects.toMatchObject({ code: 'rate_limited' });
		});
	});

	it('prune stale counters on writes, a bounded batch at a time', async () => {
		await withRollback(async (tx) => {
			const time = clock();
			const deps = { db: tx, now: time.now };
			const { staleAfterMs, batch } = RATE_LIMIT_PRUNE;
			const hit = (ip: string) => enforceRateLimit('signin.verify', { ip }, request(), deps);
			const keys = async () =>
				(await tx.execute<{ key: string }>(sql`select key from auth_rate_limits`)).rows
					.map((row) => row.key)
					.sort();

			// Yesterday, more one-off client addresses than one prune removes.
			for (let i = 0; i < batch + 5; i++) await hit(`10.0.${i >> 8}.${i & 255}`);
			time.advance(staleAfterMs / 2);
			await hit('192.0.2.1'); // still counting at the end
			time.advance(staleAfterMs / 2 + 1);

			// Every new counter retires up to `batch` stale ones (never a live one).
			await hit('192.0.2.2');
			expect(await keys()).toHaveLength(5 + 2);
			await hit('192.0.2.3');
			expect(await keys()).toEqual([
				'signin.verify:ip:192.0.2.1',
				'signin.verify:ip:192.0.2.2',
				'signin.verify:ip:192.0.2.3'
			]);
		});
	});

	it('guard every auth entry point: sign-in, setup token checks and recovery codes', async () => {
		await withRollback(async (tx) => {
			const client = request();
			const deps = { db: tx };
			for (let i = 0; i < RATE_LIMITS['signin.options'].limit; i++) await beginSignIn(client, deps);
			await expect(beginSignIn(client, deps)).rejects.toMatchObject({ code: 'rate_limited' });

			for (let i = 0; i < RATE_LIMITS['signin.verify'].limit; i++) {
				await expect(completeSignIn({}, undefined, client, deps)).rejects.toMatchObject({
					code: 'invalid_input'
				});
			}
			await expect(completeSignIn({}, undefined, client, deps)).rejects.toMatchObject({
				code: 'rate_limited'
			});

			for (let i = 0; i < RATE_LIMITS.setup.limit; i++) {
				await checkSetupAccess('wrong-token-wrong-token', client, {
					...deps,
					config: SETUP_CONFIG
				});
			}
			// Even the right token is refused while the client is over the limit.
			await expect(
				checkSetupAccess(SETUP_TOKEN, client, { ...deps, config: SETUP_CONFIG })
			).rejects.toMatchObject({ code: 'rate_limited' });

			for (let i = 0; i < RATE_LIMITS.recovery.limit; i++) {
				await expect(
					redeemRecoveryCode('AAAA-AAAA-AAAA-AAAA', undefined, client, deps)
				).rejects.toMatchObject({ code: 'invalid_code' });
			}
			await expect(
				redeemRecoveryCode('AAAA-AAAA-AAAA-AAAA', undefined, client, deps)
			).rejects.toMatchObject({ code: 'rate_limited' });
		});
	});

	it('cap recovery-code guessing across all clients', async () => {
		await withRollback(async (tx) => {
			const { limit } = RATE_LIMITS['recovery.global'];
			for (let i = 0; i < limit; i++) {
				await expect(
					redeemRecoveryCode('AAAA-AAAA-AAAA-AAAA', undefined, request(), { db: tx })
				).rejects.toMatchObject({ code: 'invalid_code' });
			}
			await expect(
				redeemRecoveryCode('AAAA-AAAA-AAAA-AAAA', undefined, request(), { db: tx })
			).rejects.toMatchObject({ code: 'rate_limited' });
		});
	});

	it('never let the global recovery cap refuse a valid code', async () => {
		await withRollback(async (tx) => {
			const time = clock();
			const deps = { db: tx, now: time.now };
			const owner = await setUpOwner(tx, { now: time.now });
			// One client fills the global cap alone, never exceeding its own per-client limit.
			const attacker = request({ ip: '203.0.113.66' });
			const { limit: perClient, windowMs } = RATE_LIMITS.recovery;
			for (let i = 0; i < RATE_LIMITS['recovery.global'].limit; i++) {
				if (i > 0 && i % perClient === 0) time.advance(windowMs);
				await expect(
					redeemRecoveryCode('AAAA-AAAA-AAAA-AAAA', undefined, attacker, deps)
				).rejects.toMatchObject({ code: 'invalid_code' });
			}
			// Wrong codes are now refused from any client...
			await expect(
				redeemRecoveryCode('AAAA-AAAA-AAAA-AAAA', undefined, request(), deps)
			).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
			// ...but the owner's valid code, from another network, still signs in.
			await expect(
				redeemRecoveryCode(owner.recoveryCodes[0], undefined, request(), deps)
			).resolves.toMatchObject({ remaining: 9, session: { kind: 'recovery' } });
		});
	});

	it('never let a full sign-out bucket keep a live session signed in', async () => {
		await withRollback(async (tx) => {
			const deps = { db: tx };
			const owner = await setUpOwner(tx);
			// Someone on the same NAT or Wi-Fi (one client address) fills the sign-out bucket.
			const sameNetwork = request({ ip: '203.0.113.77' });
			for (let i = 0; i < RATE_LIMITS.signout.limit; i++) {
				await signOut(undefined, sameNetwork, deps);
			}
			await expect(signOut(undefined, sameNetwork, deps)).rejects.toMatchObject({
				code: 'rate_limited',
				status: 429
			});
			// The owner's sign-out from that address still ends the session...
			await expect(signOut(owner.token, sameNetwork, deps)).resolves.toBeUndefined();
			expect(await validateSessionToken(owner.token, deps)).toBeNull();
			const repo = createAuthRepository(tx);
			expect(await repo.findSession(owner.session.id)).toMatchObject({ revokedReason: 'signout' });
			expect(await repo.recentEvents(1)).toMatchObject([
				{ type: 'signout', sessionId: owner.session.id }
			]);
			// ...once: the ended token is just another request without a session, limited again.
			await expect(signOut(owner.token, sameNetwork, deps)).rejects.toMatchObject({
				code: 'rate_limited'
			});
		});
	});
});
