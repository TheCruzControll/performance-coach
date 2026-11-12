import { version } from '$app/env';
import { buildActions } from '#lib/server/forms/build.ts';
import { ownerId } from '#lib/server/forms/read.ts';
import { logWhenSettled } from '#lib/server/observability/timing.ts';
import type { Actions, PageServerLoad } from './$types';
import { loadToday } from './load.server';

/** Today: the setup card, the program state, and the streamed plan and week (load.server.ts). */
export const load: PageServerLoad = async ({ locals, request, route, url }) => {
	const data = await loadToday(ownerId(locals), {
		now: new Date(),
		origin: {
			requestId: locals.requestId,
			method: request.method,
			path: url.pathname,
			routeId: route.id,
			appVersion: version
		}
	});
	const streamed = [data.plan, data.week].filter((p) => p !== undefined);
	if (streamed.length) logWhenSettled(route.id, streamed);
	return data;
};

/** Build my program: ?/preview, then ?/build (forms/build.ts). */
export const actions = buildActions() satisfies Actions;
