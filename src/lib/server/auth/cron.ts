/**
 * The `cron` access class (routes.ts): a scheduled job's endpoint, which only a caller holding
 * CRON_SECRET opens, normally Vercel Cron sending `Authorization: Bearer <CRON_SECRET>`. A
 * session never substitutes for it, signed in or not.
 *
 * - While CRON_SECRET is unset, or too short to trust (backup/config.ts), the endpoint does not
 *   exist: 404.
 * - Otherwise the header must be exactly `Bearer <CRON_SECRET>` (the scheme's case, one space, no
 *   padding). The secret is compared as SHA-256 digests with timingSafeEqual, so neither its
 *   length nor its content leaks through timing.
 * - Only GET runs the job; every other method answers 405 (HEAD included, which SvelteKit would
 *   otherwise answer by running GET).
 *
 * guard.ts checks this before any session logic, and the endpoint checks it again. A refusal
 * names its reason, never the header.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { cronConfig, type BackupEnv } from '../backup/config';

const SCHEME = 'Bearer ';

export type CronCheck =
	| { ok: true }
	| { ok: false; status: 404; reason: 'not_configured' }
	| { ok: false; status: 401; reason: 'missing' | 'malformed' | 'mismatch' };

/** Whether `request` carries the cron's secret, or why it is refused. */
export function verifyCronRequest(request: Pick<Request, 'headers'>, env: BackupEnv): CronCheck {
	const config = cronConfig(env);
	if (config === null) return { ok: false, status: 404, reason: 'not_configured' };
	const header = request.headers.get('authorization');
	if (header === null) return { ok: false, status: 401, reason: 'missing' };
	if (!header.startsWith(SCHEME)) return { ok: false, status: 401, reason: 'malformed' };
	const digest = createHash('sha256').update(header.slice(SCHEME.length), 'utf8').digest();
	return timingSafeEqual(digest, config.secretDigest)
		? { ok: true }
		: { ok: false, status: 401, reason: 'mismatch' };
}

/** The only method a cron endpoint serves. */
export const CRON_METHOD = 'GET';

/** The answer to a refused cron request: 404 as if absent, 401, or 405 for another method. */
export function cronRefusal(status: 401 | 404 | 405): Response {
	const headers: Record<string, string> = { 'cache-control': 'no-store' };
	if (status === 405) headers.allow = CRON_METHOD;
	const body =
		status === 404
			? { error: 'not_found', message: 'Not found.' }
			: status === 405
				? { error: 'method_not_allowed', message: `Only ${CRON_METHOD} is served.` }
				: { error: 'unauthorized', message: 'A valid bearer token is required.' };
	return Response.json(body, { status, headers });
}
