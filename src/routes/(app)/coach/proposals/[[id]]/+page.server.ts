import { version } from '$app/env';
import { coachStatus } from '#lib/server/agent/coach.ts';
import { ownerId } from '#lib/server/forms/read.ts';
import type { PageServerLoad } from './$types';
import { loadInbox } from './inbox.server';

/**
 * The Proposals inbox: waiting first, then decided, a page at a time, and proposal <id>'s detail
 * (inbox.server.ts); whether the coach can answer, for 'Ask for changes' (coachStatus, read
 * without loading a provider).
 */
export const load: PageServerLoad = async ({ locals, params, request, route, url }) => ({
	canAsk: coachStatus().status === 'ready',
	...(await loadInbox(ownerId(locals), {
		id: params.id,
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
