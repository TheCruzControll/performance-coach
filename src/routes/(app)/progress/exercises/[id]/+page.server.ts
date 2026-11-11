import { version } from '$app/env';
import { parsePeriod } from '#lib/domain/analytics/periods.ts';
import { testRoutesEnabled } from '#lib/server/env.ts';
import { ownerId } from '#lib/server/forms/read.ts';
import type { PageServerLoad } from './$types';
import { loadExerciseDetail, type ExerciseDetailDeps } from './load';

/**
 * TEST ONLY: with test routes enabled (never in production), this cookie set to
 * 'progress-exercise' makes the exercise read throw, so e2e can show the load-failed notice and
 * recover with Retry.
 */
const FAIL_COOKIE = 'pc-test-fail';

const failing: ExerciseDetailDeps['analytics'] = () => {
	throw new Error('Forced failure (test routes)');
};

/** One lift's progress (load.ts) over the period in ?period; an unknown id is a 404. */
export const load: PageServerLoad = async ({ cookies, locals, params, request, route, url }) => {
	const forced = testRoutesEnabled() && cookies.get(FAIL_COOKIE) === 'progress-exercise';
	const origin = {
		requestId: locals.requestId,
		method: request.method,
		path: url.pathname,
		routeId: route.id,
		appVersion: version
	};
	return loadExerciseDetail(
		ownerId(locals),
		{ exerciseId: params.id, period: parsePeriod(url.searchParams.get('period')), origin },
		new Date(),
		forced ? { analytics: failing } : {}
	);
};
