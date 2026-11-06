import { version } from '$app/env';
import { ownerId } from '#lib/server/forms/read.ts';
import type { PageServerLoad } from './$types';
import { loadTrainWeek } from './week.server';

/** Train's week, server-rendered for the owner's today or for ?week=n (week.server.ts). */
export const load: PageServerLoad = ({ locals, request, route, url }) =>
	loadTrainWeek(ownerId(locals), {
		now: new Date(),
		week: url.searchParams.get('week'),
		origin: {
			requestId: locals.requestId,
			method: request.method,
			path: url.pathname,
			routeId: route.id,
			appVersion: version
		}
	});
