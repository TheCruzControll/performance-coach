import { version } from '$app/env';
import { getEnv } from '#lib/server/env.ts';
import { logWhenSettled } from '#lib/server/observability/timing.ts';
import { recordServerError } from '#lib/server/services/errors.ts';
import { checkHealth } from '#lib/server/services/health.ts';
import { getVitalsSummary } from '#lib/server/services/vitals.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, request, url, route }) => {
	// Streamed: the page renders immediately and these fill in when ready.
	const health = checkHealth({ version, timeoutMs: 1500 });
	const vitals = getVitalsSummary(7).catch(async (error: unknown) => {
		// The response has already started, so handleError never sees this: the card degrades
		// to "no samples", and the failure is logged and recorded like any server error.
		await recordServerError({
			error,
			kind: 'streamed',
			status: 500,
			requestId: locals.requestId,
			method: request.method,
			path: url.pathname,
			routeId: route.id,
			appVersion: version,
			context: { load: 'getVitalsSummary' }
		});
		return null;
	});
	logWhenSettled(route.id, [health, vitals]);

	return {
		version,
		appEnv: getEnv().appEnv,
		owner: { name: locals.session?.ownerName ?? 'Owner' },
		health,
		vitals
	};
};
