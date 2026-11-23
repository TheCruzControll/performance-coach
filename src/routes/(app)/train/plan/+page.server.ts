import { redirect } from '@sveltejs/kit';
import { version } from '$app/env';
import { ownerId } from '#lib/server/forms/read.ts';
import type { PageServerLoad } from './$types';
import { loadPlan } from './plan.server';

/**
 * The whole plan (plan.server.ts); with no program, Train, which says what comes first. End this
 * plan posts to Train's own ?/end action.
 */
export const load: PageServerLoad = async ({ locals, request, route, url }) => {
	const plan = await loadPlan(ownerId(locals), {
		now: new Date(),
		origin: {
			requestId: locals.requestId,
			method: request.method,
			path: url.pathname,
			routeId: route.id,
			appVersion: version
		}
	});
	if (plan.state === 'none') redirect(303, '/train');
	return plan;
};
