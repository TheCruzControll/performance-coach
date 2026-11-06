import { version } from '$app/env';
import { ownerId } from '#lib/server/forms/read.ts';
import type { PageServerLoad } from './$types';
import { loadSessionDetail } from './detail.server';

/** One planned session by lineage, ?v=n for an older version (detail.server.ts). */
export const load: PageServerLoad = ({ locals, params, request, route, url }) =>
	loadSessionDetail(ownerId(locals), {
		key: params.key,
		version: url.searchParams.get('v'),
		origin: {
			requestId: locals.requestId,
			method: request.method,
			path: url.pathname,
			routeId: route.id,
			appVersion: version
		}
	});
