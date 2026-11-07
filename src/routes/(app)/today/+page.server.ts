import { version } from '$app/env';
import { ownerId } from '#lib/server/forms/read.ts';
import type { PageServerLoad } from './$types';
import { loadTodaySetup } from './setup.server';

/**
 * Today: the setup card is awaited, not streamed. It is the screen's largest content, and a
 * streamed card only replaces its skeleton after hydration, which put LCP at ~2.8 s.
 */
export const load: PageServerLoad = async ({ locals, request, route, url }) => ({
	setup: await loadTodaySetup(ownerId(locals), {
		requestId: locals.requestId,
		method: request.method,
		path: url.pathname,
		routeId: route.id,
		appVersion: version
	})
});
