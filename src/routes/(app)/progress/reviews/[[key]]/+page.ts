import type { PageLoad } from './$types';
import type { WeeklyReviewData } from './load';

/**
 * Each review kind's view as a string-literal relative import, awaited on the server and in the
 * browser alike (no SSR guard): the server renders the review's figures and verdicts, so it reads
 * without JavaScript and nothing moves at hydration. cycle-review-screen adds CycleReview.
 */
const VIEWS = {
	weekly: () => import('./WeeklyReview.svelte')
} as const satisfies Record<WeeklyReviewData['kind'], () => Promise<unknown>>;

export const load: PageLoad = async ({ data }) => {
	if (data.failed || !data.selected) return { ...data, View: null };
	return { ...data, View: (await VIEWS[data.selected.kind]()).default };
};
