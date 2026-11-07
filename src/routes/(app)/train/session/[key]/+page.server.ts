import { version } from '$app/env';
import { ownerId } from '#lib/server/forms/read.ts';
import type { Actions, PageServerLoad } from './$types';
import { loadSessionDetail } from './detail.server';
import { editActions } from './edits.server';

/** One planned session by lineage, ?v=n for an older version (detail.server.ts). */
export const load: PageServerLoad = ({ locals, params, request, route, url }) =>
	loadSessionDetail(ownerId(locals), {
		key: params.key,
		version: url.searchParams.get('v'),
		now: new Date(),
		origin: {
			requestId: locals.requestId,
			method: request.method,
			path: url.pathname,
			routeId: route.id,
			appVersion: version
		}
	});

/** Move, and its check before saving (edits.server.ts). */
export const actions = editActions() satisfies Actions;
