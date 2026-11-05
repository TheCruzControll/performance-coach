<script lang="ts">
	import { onNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import AppShell from './AppShell.svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

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
