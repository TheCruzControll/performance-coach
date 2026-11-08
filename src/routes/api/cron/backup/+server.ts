import { json } from '@sveltejs/kit';
import type { Config } from '@sveltejs/adapter-vercel';
import { version } from '$app/env';
import { cronRefusal, verifyCronRequest } from '#lib/server/auth/cron.ts';
import { getEnv } from '#lib/server/env.ts';
import { isBackupRunError, runBackup } from '#lib/server/services/backups/index.ts';
import { recordServerError } from '#lib/server/services/errors.ts';
import type { RequestHandler } from './$types';

/**
 * Hobby's ceiling without Fluid compute, and valid with it: a run exports and seals in about 30 s
 * at most and reads back and prunes in about 10 s (scripts/explain/backup.explain.ts).
 * scripts/vercel-build.test.ts keeps it at 60 or less.
 */
export const config: Config = { maxDuration: 60 };

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * The daily backup (vercel.json's one cron): one verified run (services/backups/run.ts). The guard
 * has already required `Authorization: Bearer <CRON_SECRET>` (auth/cron.ts); it is checked again
 * here, so this handler never runs on a session alone. A GET with a side effect, justified only by
 * that secret.
 *
 * - 200 `{status, pathname, bytes, sha256, tables, rows, durationMs}`: names, sizes and counts,
 *   never a row
 * - 409 `already_running`: another run holds the export's lock
 * - 503 `backup_not_configured` with the missing and invalid variables' names
 * - 500 `{error, requestId}`: the run's code; the failure is in app_errors (kind 'cron')
 */
export const GET: RequestHandler = async ({ request, locals }) => {
	const env = getEnv();
	const check = verifyCronRequest(request, env);
	if (!check.ok) return cronRefusal(check.status);
	try {
		const result = await runBackup(
			{ now: new Date(), trigger: 'cron', env, appVersion: version, requestId: locals.requestId },
			{ record: recordServerError }
		);
		const { pathname, bytes, sha256, tables, rows, durationMs } = result;
		return json(
			{ status: 'ok', pathname, bytes, sha256, tables, rows, durationMs },
			{ headers: NO_STORE }
		);
	} catch (error) {
		if (isBackupRunError(error, 'already_running')) {
			return json({ error: error.code }, { status: 409, headers: NO_STORE });
		}
		if (isBackupRunError(error, 'backup_not_configured')) {
			const { missing, invalid } = error.detail;
			return json({ error: error.code, missing, invalid }, { status: 503, headers: NO_STORE });
		}
		const code = isBackupRunError(error) ? error.code : 'backup_failed';
		return json({ error: code, requestId: locals.requestId }, { status: 500, headers: NO_STORE });
	}
};

/** Without this, SvelteKit would answer HEAD by running GET (the guard answers 405 first). */
export const HEAD: RequestHandler = () => cronRefusal(405);
