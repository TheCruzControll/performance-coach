/**
 * The weekly review's trends and sections (ReviewBody) in a chunk of their own, so their code is
 * not initial JS (scripts/check-budgets.ts counts what +page.ts awaits): the server renders them
 * as static markup (`servedBody`), which the page keeps as sent while it hydrates, and
 * WeeklyReview hydrates that markup in place once the chunk arrives. Any other load waits for the
 * chunk with the view's own, so the review arrives whole.
 *
 * Not in +page.ts: an import written in a universal load's own source counts as initial JS, and
 * the hydrating load only starts this one (as Progress's trends.ts does).
 */
import type { Component } from 'svelte';
import type { WeeklyReviewData } from './load';

export interface BodyProps {
	review: WeeklyReviewData;
}

/** What the browser's hydrating load passes: the page keeps the server's markup (ServedInPlace). */
export const SERVED_IN_PLACE = 'served';

/** ReviewBody. Rejects if its chunk fails to load (offline, or gone after a deploy). */
export const importBody = async (): Promise<Component<BodyProps>> =>
	(await import('./ReviewBody.svelte')).default;

/**
 * The body as static HTML for the server to send in its place, rendered whole (its hydration
 * markers included) so the browser can hydrate it in place. Server only: `import.meta.env.SSR`
 * keeps the renderer out of the browser's build.
 */
export async function servedBody(props: BodyProps): Promise<string> {
	const server = import.meta.env.SSR ? await import('svelte/server') : undefined;
	if (!server) throw new Error('The review body is served by the server only');
	return server.render(await importBody(), { props }).body;
}
