<script lang="ts">
	import { onMount } from 'svelte';
	import { onNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { startVitalsReporting } from '#lib/client/vitals.ts';
	import AppShell from './AppShell.svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// Real-user monitoring needs a session (POST /api/vitals is owner-only), so it starts with the
	// signed-in shell, after the page is interactive; it never competes with hydration. Metrics of
	// a sign-in screen visited first in the same page are still attributed to it (root layout).
	onMount(() => {
		const start = () => void startVitalsReporting();
		if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 3000 });
		else setTimeout(start, 1500);
	});

	// Cross-fade between tabs with the View Transitions API where available.
	onNavigate((navigation) => {
		if (
			!document.startViewTransition ||
			navigation.from?.url.pathname === navigation.to?.url.pathname ||
			matchMedia('(prefers-reduced-motion: reduce)').matches
		) {
			return;
		}
		return new Promise((done) => {
			document.startViewTransition(async () => {
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
