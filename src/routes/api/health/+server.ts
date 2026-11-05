import { json } from '@sveltejs/kit';
import { version } from '$app/env';
import { checkHealth } from '#lib/server/services/health.ts';
import type { RequestHandler } from './$types';

/** Liveness + readiness: a real round-trip to Postgres. 503 when the database is down. */
export const GET: RequestHandler = async () => {
	const report = await checkHealth({ version });
	return json(report, {
		status: report.ok ? 200 : 503,
		headers: { 'cache-control': 'no-store' }
	});
};
