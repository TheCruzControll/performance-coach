import { version } from '$app/env';
import { coachStatus } from '#lib/server/agent/coach.ts';
import { ownerId } from '#lib/server/forms/read.ts';
import type { PageServerLoad } from './$types';
import { loadCoachScreen } from './coach.server';

/**
 * Coach: whether the coach can answer (coachStatus, read without loading a provider), then the
 * recent conversations on /coach or conversation <id>'s messages (coach.server.ts).
 */
export const load: PageServerLoad = async ({ locals, params, request, route, url }) => ({
	coach: coachStatus(),
	...(await loadCoachScreen(ownerId(locals), {
		thread: params.thread,
		search: url.searchParams,
		origin: {
			requestId: locals.requestId,
			method: request.method,
			path: url.pathname,
			routeId: route.id,
			appVersion: version
		}
	}))
});
