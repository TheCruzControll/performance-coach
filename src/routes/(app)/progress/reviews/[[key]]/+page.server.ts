import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { version } from '$app/env';
import { resolve } from '$app/paths';
import { testRoutesEnabled } from '#lib/server/env.ts';
import { ownerId } from '#lib/server/forms/read.ts';
import { decideCycle, decideReview, proposeDeloadAgainAction } from '#lib/server/forms/reviews.ts';
import type { Actions, PageServerLoad } from './$types';
import {
	createCycle,
	createReview,
	loadReviews,
	parseReviewKey,
	refreshReview,
	type ReviewsDeps,
	type ReviewsRequest
} from './load';

/**
 * TEST ONLY: with test routes enabled (never in production), this cookie set to 'reviews' makes
 * the list read throw, so e2e can show the load-failed notice and recover with Retry.
 */
const FAIL_COOKIE = 'pc-test-fail';

const failing: ReviewsDeps['list'] = () => {
	throw new Error('Forced failure (test routes)');
};

/** The request as a recorded failure carries it: its id, method, path, route and app version. */
const originOf = ({ locals, request, route, url }: RequestEvent): ReviewsRequest['origin'] => ({
	requestId: locals.requestId,
	method: request.method,
	path: url.pathname,
	routeId: route.id,
	appVersion: version
});

/** The reviews and the one the key selects (load.ts); a bad key is a 404. */
export const load: PageServerLoad = async (event) => {
	const { cookies, locals, params } = event;
	const forced = testRoutesEnabled() && cookies.get(FAIL_COOKIE) === 'reviews';
	const origin = originOf(event);
	return loadReviews(
		ownerId(locals),
		{ key: params.key, origin },
		new Date(),
		forced ? { list: failing } : {}
	);
};

export const actions = {
	/** Create the week's review (or find it), then open it: a 303, with or without JavaScript. */
	create: async (event) => {
		const week = (await event.request.formData()).get('weekStartsOn');
		const origin = originOf(event);
		const result = await createReview(ownerId(event.locals), String(week ?? ''), new Date(), {
			origin
		});
		if (!result.ok) return fail(result.status, result.data);
		redirect(303, resolve('/(app)/progress/reviews/[[key]]', { key: result.key }));
	},
	/** Create a block's review (or find it), then open it, as create does for a week. */
	createCycle: async ({ locals, request }) => {
		const form = await request.formData();
		const programId = String(form.get('programId') ?? '');
		const blockLineage = String(form.get('blockLineage') ?? '');
		const result = await createCycle(ownerId(locals), { programId, blockLineage }, new Date());
		if (!result.ok) return fail(result.status, result.data);
		redirect(303, resolve('/(app)/progress/reviews/[[key]]', { key: result.key }));
	},
	/** Refresh an out-of-date review (load.ts refreshReview), then show its live revision. */
	refresh: async (event) => {
		const id = (await event.request.formData()).get('reviewId');
		const origin = originOf(event);
		const result = await refreshReview(ownerId(event.locals), String(id ?? ''), new Date(), {
			origin
		});
		if (!result.ok) return fail(result.status, result.data);
		redirect(303, resolve('/(app)/progress/reviews/[[key]]', { key: event.params.key }));
	},
	/** Generate next week from the ticked changes (forms/reviews.ts). */
	decide: (event) => decide(event, 'decide'),
	/** Keep next week as planned, with an optional reason. */
	keep: (event) => decide(event, 'keep'),
	/** Propose again a deload that went stale or late: the review's own proposal, asked for again (forms/reviews.ts). */
	proposeAgain: (event) => {
		const key = parseReviewKey(event.params.key);
		return proposeDeloadAgainAction({
			locals: event.locals,
			weekStartsOn: key?.kind === 'weekly' ? key.weekStartsOn : null,
			origin: originOf(event)
		});
	},
	/** Plan the next block from the start chosen, as its preview showed it (forms/reviews.ts). */
	startCycle: async ({ locals, params, request }) => {
		if (parseReviewKey(params.key)?.kind !== 'cycle')
			return fail(404, { reason: 'not_found' as const });
		const result = await decideCycle(ownerId(locals), { form: await request.formData() });
		// Posted without JavaScript: the whole plan, as the toast would.
		const href = 'href' in result && result.href;
		if (href && !request.headers.has('x-sveltekit-action')) redirect(303, href);
		return result;
	}
} satisfies Actions;

async function decide(
	{ locals, params, request }: Parameters<Actions[string]>[0],
	mode: 'decide' | 'keep'
) {
	const owner = ownerId(locals);
	const key = parseReviewKey(params.key);
	if (key?.kind !== 'weekly') return fail(404, { reason: 'not_found' as const });
	const form = await request.formData();
	const result = await decideReview(owner, { form, mode, weekStartsOn: key.weekStartsOn });
	// Posted without JavaScript (or before the card's script loaded): Train, as the toast would.
	const href = 'href' in result && result.href;
	if (href && !request.headers.has('x-sveltekit-action')) redirect(303, href);
	return result;
}
