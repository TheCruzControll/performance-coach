import { describe, expect, it } from 'vitest';
import { createAuthRepository } from '../../../src/lib/server/db';
import { beginSignIn, completeSignIn } from '../../../src/lib/server/auth/passkeys';
import { RATE_LIMITS } from '../../../src/lib/server/auth/policy';
import { enforceRateLimit } from '../../../src/lib/server/auth/rate-limit';
import { redeemRecoveryCode } from '../../../src/lib/server/auth/recovery';
import { checkSetupAccess } from '../../../src/lib/server/auth/setup';
import { withRollback } from '../helpers';
import { clock, request, SETUP_CONFIG, SETUP_TOKEN } from './fixtures';

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
});
