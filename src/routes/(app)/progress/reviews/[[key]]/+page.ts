import { browser } from '$app/env';
import { resolve } from '$app/paths';
import type { Component, Snippet } from 'svelte';
import type { PageLoad } from './$types';
import type { CycleReviewData } from './cycle-data';
import type { ReviewRow, WeeklyReviewData } from './load';
import { importBody, servedBody, SERVED_IN_PLACE, type BodyProps } from './review-body';

/**
 * Each review kind's view as a string-literal relative import, awaited on the server and in the
 * browser alike (no SSR guard): the server renders the review's figures and verdicts, so it reads
 * without JavaScript and nothing moves at hydration.
 */
const VIEWS = {
	weekly: () => import('./WeeklyReview.svelte'),
	cycle: () => import('./CycleReview.svelte')
} as const satisfies Record<(WeeklyReviewData | CycleReviewData)['kind'], () => Promise<unknown>>;

/** What each kind's view takes: the weekly review also takes its body (review-body.ts). */
type View = Component<{
	review: WeeklyReviewData | CycleReviewData;
	earlierCycles?: Snippet<[ReviewRow[]]>;
	Body?: Component<BodyProps>;
	body?: Promise<Component<BodyProps>>;
	served?: string;
}>;

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
	const none = { Body: undefined, body: undefined, served: undefined };
	if (data.failed || !data.selected) return { ...data, View: null, ...none };
	const selected = data.selected;
	// Each kind's view takes that kind's review, which is the one selected.
	const viewOf = async () => (await VIEWS[selected.kind]()).default as unknown as View;
	// Only the weekly review has a body in a chunk of its own.
	if (selected.kind !== 'weekly') return { ...data, View: await viewOf(), ...none };
	if (!browser) {
		const View = await viewOf();
		const served = await servedBody({ review: selected });
		return { ...data, View, Body: undefined, body: undefined, served };
	}
	// Started with the view's own import. A failed import is WeeklyReview's to show (Retry).
	const body = importBody();
	body.catch(() => {});
	const View = await viewOf();
	if (kept) return { ...data, View, Body: undefined, body, served: SERVED_IN_PLACE };
	return { ...data, View, Body: await body, body: undefined, served: undefined };
};
