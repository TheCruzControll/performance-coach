import { fail, redirect } from '@sveltejs/kit';
import { version } from '$app/env';
import { resolve } from '$app/paths';
import { testRoutesEnabled } from '#lib/server/env.ts';
import { ownerId } from '#lib/server/forms/read.ts';
import type { Actions, PageServerLoad } from './$types';
import { createReview, loadReviews, refreshReview, type ReviewsDeps } from './load';

/**
 * TEST ONLY: with test routes enabled (never in production), this cookie set to 'reviews' makes
 * the list read throw, so e2e can show the load-failed notice and recover with Retry.
 */
const FAIL_COOKIE = 'pc-test-fail';

const failing: ReviewsDeps['list'] = () => {
	throw new Error('Forced failure (test routes)');
};

/** The reviews and the one the key selects (load.ts); a bad key is a 404. */
export const load: PageServerLoad = async ({ cookies, locals, params, request, route, url }) => {
	const forced = testRoutesEnabled() && cookies.get(FAIL_COOKIE) === 'reviews';
	const origin = {
		requestId: locals.requestId,
		method: request.method,
		path: url.pathname,
		routeId: route.id,
		appVersion: version
	};
	return loadReviews(
		ownerId(locals),
		{ key: params.key, origin },
		new Date(),
		forced ? { list: failing } : {}
	);
};

export const actions = {
	/** Create the week's review (or find it), then open it: a 303, with or without JavaScript. */
	create: async ({ locals, request }) => {
		const week = (await request.formData()).get('weekStartsOn');
		const result = await createReview(ownerId(locals), String(week ?? ''), new Date());
		if (!result.ok) return fail(result.status, result.data);
		redirect(303, resolve('/(app)/progress/reviews/[[key]]', { key: result.key }));
	},
	/** Refresh an out-of-date review (load.ts refreshReview), then show its live revision. */
	refresh: async ({ locals, params, request }) => {
		const id = (await request.formData()).get('reviewId');
		const result = await refreshReview(ownerId(locals), String(id ?? ''), new Date());
		if (!result.ok) return fail(result.status, result.data);
		redirect(303, resolve('/(app)/progress/reviews/[[key]]', { key: params.key }));
	}
} satisfies Actions;
