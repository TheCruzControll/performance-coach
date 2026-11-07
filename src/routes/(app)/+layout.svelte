<script lang="ts">
	import { onMount } from 'svelte';
	import { onNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import AppShell from './AppShell.svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// Real-user monitoring needs a session (POST /api/vitals is owner-only), so it starts with the
	// signed-in shell, after the page is interactive; it never competes with hydration. Metrics of
	// a sign-in screen visited first in the same page are still attributed to it (root layout).
	onMount(() => {
		const start = () =>
			void import('#lib/client/vitals.ts').then((rum) => rum.startVitalsReporting());
		if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 3000 });
		else setTimeout(start, 1500);
	});

	// Cross-fade between tabs with the View Transitions API where available. SvelteKit renders a
	// navigation once this callback lets it go, which is when the browser has captured the old
	// screen: WebKit can take a second or more, while the new URL is already in place. A later
	// navigation (Back, another tab) can finish in the meantime, and SvelteKit would still render
	// the earlier one over it, so a navigation overtaken like that is left unrendered.
	let latest = 0;
	onNavigate((navigation) => {
		const id = ++latest;
		if (
			!document.startViewTransition ||
			navigation.from?.url.pathname === navigation.to?.url.pathname ||
			matchMedia('(prefers-reduced-motion: reduce)').matches
		) {
			return;
		}
		return new Promise((done) => {
			const transition = document.startViewTransition(async () => {
				if (id !== latest) {
					transition.ready.catch(() => {}); // skipped on purpose: nothing to report
					transition.skipTransition();
					return;
				}
				done();
				await navigation.complete;
			});
		});
	});
</script>

<AppShell
	pathname={page.url.pathname}
	hideOfflineNotice={Boolean(page.error) || page.data.offlineScreen === true}
>
	{@render children()}
</AppShell>
