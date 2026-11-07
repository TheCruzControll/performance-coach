import { version } from '$app/env';
import { ownerId } from '#lib/server/forms/read.ts';
import type { PageServerLoad } from './$types';
import { loadHistory } from './history.server';

/** The program's versions (?before=n for older ones), or version n read-only (history.server.ts). */
export const load: PageServerLoad = ({ locals, params, request, route, url }) =>
	loadHistory(ownerId(locals), {
		version: params.version,
		before: url.searchParams.get('before'),
		now: new Date(),
		origin: {
			requestId: locals.requestId,
			method: request.method,
			path: url.pathname,
			routeId: route.id,
			appVersion: version
		}
	});
