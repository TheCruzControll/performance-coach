import type { Component, Snippet } from 'svelte';
import type { PageLoad } from './$types';
import type { CycleReviewData } from './cycle-data';
import type { ReviewRow, WeeklyReviewData } from './load';

/**
 * Each review kind's view as a string-literal relative import, awaited on the server and in the
 * browser alike (no SSR guard): the server renders the review's figures and verdicts, so it reads
 * without JavaScript and nothing moves at hydration.
 */
const VIEWS = {
	weekly: () => import('./WeeklyReview.svelte'),
	cycle: () => import('./CycleReview.svelte')
} as const satisfies Record<(WeeklyReviewData | CycleReviewData)['kind'], () => Promise<unknown>>;

export const load: PageLoad = async ({ data }) => {
	if (data.failed || !data.selected) return { ...data, View: null };
	// Each kind's view takes that kind's review, which is the one selected.
	const View = (await VIEWS[data.selected.kind]()).default as unknown as Component<{
		review: WeeklyReviewData | CycleReviewData;
		earlierCycles?: Snippet<[ReviewRow[]]>;
	}>;
	return { ...data, View };
};
