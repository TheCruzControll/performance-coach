import { version } from '$app/env';
import { getEnv } from '#lib/server/env.ts';
import { checkHealth } from '#lib/server/services/health.ts';
import { getVitalsSummary } from '#lib/server/services/vitals.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({
	version,
	appEnv: getEnv().appEnv,
	// Streamed: the page renders immediately and these fill in when ready.
	health: checkHealth({ version, timeoutMs: 1500 }),
	vitals: getVitalsSummary(7).catch(() => null)
});
