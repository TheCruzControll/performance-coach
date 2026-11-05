/**
 * DB-backed rate limiting for every auth endpoint (no Redis: one Postgres counter row per
 * bucket, updated with a single atomic upsert, so all server instances share the limit).
 */
import { createAuthRepository } from '../db';
import { recordAuthEvent } from './audit';
import type { AuthDeps, AuthRequest } from './context';
import { resolveDeps } from './context';
import { AuthError } from './errors';
import { RATE_LIMITS, type RateLimitBucket } from './policy';

export type RateLimitSubject = { ip: string | null } | { session: string } | 'global';

function keyFor(bucket: RateLimitBucket, subject: RateLimitSubject): string {
	if (subject === 'global') return `${bucket}:global`;
	if ('session' in subject) return `${bucket}:session:${subject.session}`;
	return `${bucket}:ip:${subject.ip ?? 'unknown'}`;
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
	const hits = await createAuthRepository(db).hitRateLimit(
		keyFor(bucket, subject),
		policy.windowMs,
		at
	);
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

/** Drop counters whose window ended long ago (called opportunistically). */
export async function pruneRateLimits(deps: AuthDeps = {}): Promise<void> {
	const { db, now } = resolveDeps(deps);
	await createAuthRepository(db).pruneRateLimits(new Date(now().getTime() - 24 * 3_600_000));
}
