/**
 * A conversation's code (Thread.svelte: its answer blocks, their words and dates), which the
 * browser loads on demand (+page.svelte), and the server's render of it as static markup
 * (`servedThread`), which the page keeps as sent until that code arrives: a conversation opened
 * by its URL paints with the page instead of after the code's chunks, one import level after
 * another (its answers are the screen's largest text, Lighthouse's LCP). Rendering it here also
 * links its styles into the page (SvelteKit's eager CSS for what the server build reaches), so
 * the markup paints as the live conversation lays out.
 *
 * Not in +page.ts: scripts/check-budgets.ts counts an import written in a universal load's own
 * source as initial JS, and the load only renders this one on the server.
 */
import type { Component, ComponentProps } from 'svelte';
import type Thread from './Thread.svelte';

type ThreadProps = ComponentProps<typeof Thread>;

export const importThread = (): Promise<{ default: Component<ThreadProps> }> =>
	import('./Thread.svelte');

/**
 * What the browser's load passes for the conversation the server rendered, while the page
 * hydrates: any markup will do, as the page keeps the server's (ServedInPlace).
 */
export const SERVED_IN_PLACE = 'served';

/**
 * The conversation's markup as static HTML for the server to send in its place, before any turn
 * is asked here, or undefined if its import failed (the browser then imports it again). Its ids
 * ($props.id) are prefixed, as this render counts apart from the page's. Server only:
 * `import.meta.env.SSR` keeps the renderer out of the browser's build.
 */
export async function servedThread(thread: ThreadProps['thread']): Promise<string | undefined> {
	const server = import.meta.env.SSR ? await import('svelte/server') : undefined;
	if (!server) throw new Error('A conversation is served by the server only');
	const Thread = await importThread().then(
		(module) => module.default,
		() => undefined
	);
	return Thread && server.render(Thread, { props: { thread }, idPrefix: 'thread' }).body;
}
