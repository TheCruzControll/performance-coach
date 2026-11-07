import { version } from '$app/env';
import { ownerId } from '#lib/server/forms/read.ts';
import { logWhenSettled } from '#lib/server/observability/timing.ts';
import type { PageServerLoad } from './$types';
import { loadTodaySetup } from './setup.server';

/** Today: the setup card is streamed, so the screen paints at once and the card fills in. */
export const load: PageServerLoad = ({ locals, request, route, url }) => {
	const setup = loadTodaySetup(ownerId(locals), {
		requestId: locals.requestId,
		method: request.method,
		path: url.pathname,
		routeId: route.id,
		appVersion: version
	});
	logWhenSettled(route.id, [setup]);
	return { setup };
};
