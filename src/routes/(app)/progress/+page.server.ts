import { version } from '$app/env';
import { testRoutesEnabled } from '#lib/server/env.ts';
import { ownerId } from '#lib/server/forms/read.ts';
import type { PageServerLoad } from './$types';
import { loadProgress, type ProgressDeps } from './load';
import { progressParams } from './params';

/**
 * TEST ONLY: with test routes enabled (never in production), this cookie set to 'progress' makes
 * the view's read throw, so e2e can show the load-failed notice and recover with Retry.
 */
const FAIL_COOKIE = 'pc-test-fail';

const failing = (): never => {
	throw new Error('Forced failure (test routes)');
};

/** Progress for the owner's today (worked out inside loadProgress, so it fails soft too), the view and period from the URL (load.ts, params.ts). */
export const load: PageServerLoad = async ({ cookies, locals, request, route, url }) => {
	const owner = ownerId(locals);
	const forced = testRoutesEnabled() && cookies.get(FAIL_COOKIE) === 'progress';
	const origin = {
		requestId: locals.requestId,
		method: request.method,
		path: url.pathname,
		routeId: route.id,
		appVersion: version
	};
	return loadProgress(
		owner,
		{ ...progressParams(url.searchParams), origin },
		new Date(),
		forced ? ({ overview: failing, strength: failing } satisfies ProgressDeps) : {}
	);
};
