import { version } from '$app/env';
import { ownerId } from '#lib/server/forms/read.ts';
import type { PageServerLoad } from './$types';
import { loadWorkoutHistory } from './history.server';

/** The completed workouts (?before=<id> for older ones), and workout <id>'s detail (history.server.ts). */
export const load: PageServerLoad = ({ locals, params, request, route, url }) =>
	loadWorkoutHistory(ownerId(locals), {
		id: params.id,
		before: url.searchParams.get('before'),
		origin: {
			requestId: locals.requestId,
			method: request.method,
			path: url.pathname,
			routeId: route.id,
			appVersion: version
		}
	});
