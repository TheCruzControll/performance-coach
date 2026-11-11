import { browser } from '$app/env';
import { resolve } from '$app/paths';
import type { PageLoad } from './$types';
import type { WeeklyReviewData } from './load';
import { importBody, servedBody, SERVED_IN_PLACE } from './review-body';

/**
 * Each review kind's view as a string-literal relative import, awaited on the server and in the
 * browser alike (no SSR guard): the server renders the review's figures and verdicts, so it reads
 * without JavaScript and nothing moves at hydration. cycle-review-screen adds CycleReview.
 */
const VIEWS = {
	weekly: () => import('./WeeklyReview.svelte')
} as const satisfies Record<WeeklyReviewData['kind'], () => Promise<unknown>>;

/**
 * Whether the next load hydrates the server's HTML: only the first one in a document opened on
 * Reviews, which keeps the server's markup of the review's body as sent until its code arrives,
 * so hydration never waits for it (review-body.ts). Any later load waits for that code with the
 * view's own.
 */
let hydrating =
	browser && location.pathname.startsWith(resolve('/(app)/progress/reviews/[[key]]', {}));

export const load: PageLoad = async ({ data }) => {
	const kept = hydrating;
	hydrating = false;
	if (data.failed || !data.selected) {
		return { ...data, View: null, Body: undefined, body: undefined, served: undefined };
	}
	if (!browser) {
		const View = (await VIEWS[data.selected.kind]()).default;
		const served = await servedBody({ review: data.selected });
		return { ...data, View, Body: undefined, body: undefined, served };
	}
	// Started with the view's own import. A failed import is WeeklyReview's to show (Retry).
	const body = importBody();
	body.catch(() => {});
	const View = (await VIEWS[data.selected.kind]()).default;
	if (kept) return { ...data, View, Body: undefined, body, served: SERVED_IN_PLACE };
	return { ...data, View, Body: await body, body: undefined, served: undefined };
};
