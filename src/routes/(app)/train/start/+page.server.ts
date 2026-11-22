import { version } from '$app/env';
import { ownerId } from '#lib/server/forms/read.ts';
import type { Actions, PageServerLoad } from './$types';
import { loadStart, startActions } from './start.server';

/** When week 1 starts, and the starts it may move to (start.server.ts). */
export const load: PageServerLoad = ({ locals, request, route, url }) =>
	loadStart(ownerId(locals), {
		now: new Date(),
		origin: {
			requestId: locals.requestId,
			method: request.method,
			path: url.pathname,
			routeId: route.id,
			appVersion: version
		}
	});

/** Move the start: ?/move (start.server.ts). */
export const actions = startActions() satisfies Actions;
