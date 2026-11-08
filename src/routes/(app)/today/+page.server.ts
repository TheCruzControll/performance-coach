import { version } from '$app/env';
import { buildActions } from '#lib/server/forms/build.ts';
import { ownerId } from '#lib/server/forms/read.ts';
import type { Actions, PageServerLoad } from './$types';
import { loadTodayProgram } from './program.server';
import { loadTodaySetup } from './setup.server';

/**
 * Today: the setup card is awaited, not streamed. It is the screen's largest content, and a
 * streamed card only replaces its skeleton after hydration, which put LCP at ~2.8 s. Once
 * onboarding is complete, whether a program exists picks the state (program.server.ts), read
 * after the setup, one query at a time.
 */
export const load: PageServerLoad = async ({ locals, request, route, url }) => {
	const owner = ownerId(locals);
	const origin = {
		requestId: locals.requestId,
		method: request.method,
		path: url.pathname,
		routeId: route.id,
		appVersion: version
	};
	const setup = await loadTodaySetup(owner, origin);
	const program = setup?.complete
		? await loadTodayProgram(owner, { now: new Date(), origin })
		: undefined;
	return { setup, program };
};

/** Build my program: ?/preview, then ?/build (forms/build.ts). */
export const actions = buildActions() satisfies Actions;
