import { browser } from '$app/env';
import type { PageLoad } from './$types';
import { SERVED_IN_PLACE, servedThread } from './thread-code';

/**
 * Whether the next load hydrates the server's HTML: only the first one in a document, and only on
 * the URL the document opened (a client navigation still shows the page it leaves). It keeps the
 * server's markup of the conversation as sent until its code arrives (thread-code.ts); any later
 * load (another conversation, 'Show older', Retry) shows loading rows until then.
 */
let hydrating = browser;

export const load: PageLoad = async ({ data, url }) => {
	const kept = hydrating && url.pathname === location.pathname;
	hydrating = false;
	const thread = data.failed ? null : data.thread;
	if (!thread) return { ...data, served: undefined };
	if (browser) return { ...data, served: kept ? SERVED_IN_PLACE : undefined };
	return { ...data, served: await servedThread(thread) };
};
