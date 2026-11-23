/**
 * DB-backed rate limiting for every auth endpoint (no Redis: one Postgres counter row per
 * bucket, updated with a single atomic upsert, so all server instances share the limit).
 */
import { createAuthRepository } from '../db';
import { recordAuthEvent } from './audit';
import { clientNetwork } from './client-network';
import type { AuthDeps, AuthRequest } from './context';
import { resolveDeps } from './context';
import { AuthError } from './errors';
import { RATE_LIMIT_PRUNE, RATE_LIMITS, type RateLimitBucket } from './policy';

export type RateLimitSubject = { ip: string | null } | { session: string } | 'global';

/**
 * Every public POST route (routes.ts `public`) and the bucket its handler counts against. A public
 * POST without an entry fails src/lib/server/auth/rate-limit.test.ts, and that test also checks
 * the handler really applies the bucket.
 */
export const PUBLIC_POST_BUCKETS = {
	'/api/auth/setup/options': 'setup',
	'/api/auth/setup/verify': 'setup',
	'/api/auth/signin/options': 'signin.options',
	'/api/auth/signin/verify': 'signin.verify',
	// Counts only a request that ends no session (signOut, sessions.ts).
	'/api/auth/signout': 'signout',
	'/api/test-support/session': 'test.session',
	// The recovery-code form action (src/routes/recover/+page.server.ts).
	'/recover': 'recovery'
} as const satisfies Record<string, RateLimitBucket>;

export type PublicPostRoute = keyof typeof PUBLIC_POST_BUCKETS;

function keyFor(bucket: RateLimitBucket, subject: RateLimitSubject): string {
	if (subject === 'global') return `${bucket}:global`;
	if ('session' in subject) return `${bucket}:session:${subject.session}`;
	return `${bucket}:ip:${clientNetwork(subject.ip ?? 'unknown')}`;
}

/**
 * Count a hit against `bucket` for `subject`; throw `rate_limited` (429) once over the limit.
 * The first rejected hit of a window is written to the audit log (not every one: a flood must
 * not become a flood of audit rows).
 */
export async function enforceRateLimit(
	bucket: RateLimitBucket,
	subject: RateLimitSubject,
	request: AuthRequest | null,
	deps: AuthDeps = {}
): Promise<void> {
	const { db, now } = resolveDeps(deps);
	const policy = RATE_LIMITS[bucket];
	const at = now();
	const repo = createAuthRepository(db);
	const hits = await repo.hitRateLimit(keyFor(bucket, subject), policy.windowMs, at);
	if (hits === 1) {
		// A new window (often a new client) retires a few long-stale counters: pruning rides on
		// writes, at most once per window per key, and stays bounded.
		const { staleAfterMs, batch } = RATE_LIMIT_PRUNE;
		await repo.pruneRateLimits(new Date(at.getTime() - staleAfterMs), batch);
	}
	if (hits <= policy.limit) return;
	if (hits === policy.limit + 1) {
		await recordAuthEvent(db, request, {
			type: 'rate_limited',
			detail: { bucket, limit: policy.limit, windowMs: policy.windowMs }
		});
	}
	throw new AuthError('rate_limited', 'Too many attempts. Wait a moment and try again.', {
		retryAfter: Math.ceil(policy.windowMs / 1000)
	});
}
