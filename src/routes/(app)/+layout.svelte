<script lang="ts">
	import { onMount } from 'svelte';
	import { onNavigate } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import { screens } from '#lib/client/screen-memory.ts';
	import { afterPaint } from '../workout/lazy.ts';
	import AppShell from './AppShell.svelte';
	import type * as Held from './HeldScreen.svelte';
	import { isAppPath, isTabRoot } from './nav';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// Real-user monitoring needs a session (POST /api/vitals is owner-only), so it starts with the
	// signed-in shell, after the page is interactive; it never competes with hydration. Metrics of
	// a sign-in screen visited first in the same page are still attributed to it (root layout).
	onMount(() => {
		// Best effort: a page that has gone offline by then, or a build replaced by a deploy, loses
		// its metrics rather than reporting an unhandled rejection.
		const start = () =>
			void import('#lib/client/vitals.ts')
				.then((rum) => rum.startVitalsReporting())
				.catch(() => {});
		if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 3000 });
		else setTimeout(start, 1500);
	});

	/**
	 * Tab feedback without waiting for the server: from the moment a navigation to another screen
	 * starts, the last time that screen showed in this page is drawn over the content, or, for a
	 * tab not shown yet, its skeleton (HeldScreen.svelte), until the screen renders with fresh
	 * data. Each tab's own screen left is kept for that (screen-memory.ts): a copy of its DOM,
	 * taken just before the next one renders, without ids or test ids, so nothing can find it
	 * twice. A copy kept on another day or longer ago than Today's TTL (today/freshness.ts) is
	 * not shown, so a revisit never shows an old day or plan. The memory goes with the app shell,
	 * and when any tab signs out (signout.ts here).
	 *
	 * HeldScreen (with what it holds for a navigation: held.ts) and the sign-out listener load
	 * once the first frame has painted, as the resume bar does (AppShell.svelte), so neither is
	 * initial JS or CSS; a tap before then is marked on the tab bar only. The copies are kept from
	 * the start, so a screen left before then still shows again.
	 */
	let HeldScreen = $state.raw<typeof Held | null>(null);
	const holding = $derived(HeldScreen?.holding(page.url, navigating.to?.url) ?? null);

	onNavigate(({ from, to }) => {
		const main = document.getElementById('main');
		// Error and offline screens are not the screen their URL shows.
		if (!from || !main || page.error || page.data.offlineScreen === true) return;
		// Only a tab's own screen is kept, one per tab, and only while the shell stays: leaving it
		// forgets the memory, so a copy for a navigation out of the tabs would be wasted work.
		if (!isTabRoot(from.url.pathname) || !to || !isAppPath(to.url.pathname)) return;
		if (from.url.pathname === to.url.pathname) return;
		const copies = [...main.children]
			.filter((child) => !child.matches('.notice-region'))
			.map((child) => child.cloneNode(true) as Element);
		for (const copy of copies) {
			for (const node of [copy, ...copy.querySelectorAll('[id], [data-testid]')]) {
				node.removeAttribute('id');
				node.removeAttribute('data-testid');
			}
		}
		screens.keep(from.url, copies);
	});

	onMount(() => {
		let stop = () => {};
		let gone = false;
		// Left out of the server build, as the resume bar is, so no page links its CSS. A chunk
		// gone after a deploy only means no held screen until the next load.
		afterPaint(() => {
			if (gone) return;
			void (
				import.meta.env.SSR
					? Promise.reject(new Error('client only'))
					: import('./HeldScreen.svelte')
			).then(
				(m) => (HeldScreen = m),
				() => {}
			);
			void import('#lib/client/workout/channel.ts').then(
				({ openTabChannel }) => {
					const channel = openTabChannel();
					const unlisten = channel?.listen((message) => {
						if (message.type === 'signed-out') screens.forget();
					});
					stop = () => {
						unlisten?.();
						channel?.close();
					};
					if (gone) stop();
				},
				() => {}
			);
		});
		return () => {
			gone = true;
			stop();
			screens.forget();
		};
	});

	// Cross-fade between tabs with the View Transitions API where available. SvelteKit renders a
	// navigation once this callback lets it go, which is when the browser has captured the old
	// screen: WebKit can take a second or more, while the new URL is already in place. A later
	// navigation (Back, another tab) can finish in the meantime, and SvelteKit would still render
	// the earlier one over it, so a navigation overtaken like that is left unrendered.
	// A navigation that starts while the last cross-fade is still under way (Back, then Forward)
	// skips that one: the browser rejects its `ready` with an AbortError, and SvelteKit rejects
	// the overtaken navigation's `complete`. Both are expected, so neither is reported as an
	// unhandled rejection (lib/client/errors.ts); any other failure of `ready` still is.
	let latest = 0;
	onNavigate((navigation) => {
		const id = ++latest;
		// A screen shown again over its last copy updates in place, without a cross-fade.
		if (
			!document.startViewTransition ||
			holding?.last ||
			navigation.from?.url.pathname === navigation.to?.url.pathname ||
			matchMedia('(prefers-reduced-motion: reduce)').matches
		) {
			return;
		}
		return new Promise((done) => {
			const transition = document.startViewTransition(async () => {
				if (id !== latest) {
					transition.skipTransition();
					return;
				}
				done();
				await navigation.complete.catch(() => {}); // overtaken: the newer one takes over
			});
			transition.ready.catch((error: unknown) => {
				if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
			});
		});
	});
</script>

<AppShell
	pathname={page.url.pathname}
	hideOfflineNotice={Boolean(page.error) || page.data.offlineScreen === true}
>
	{@render children()}
	{#snippet held()}
		{#if holding && HeldScreen}<HeldScreen.default label={holding.label} last={holding.last} />{/if}
	{/snippet}
</AppShell>
