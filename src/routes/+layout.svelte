<script lang="ts">
	import '#lib/ui/styles/app.css';
	import { onMount } from 'svelte';
	import { applyTheme, preferences } from '#lib/client/preferences.svelte.ts';
	import { startVitalsReporting } from '#lib/client/vitals.ts';
	import Toaster from '#lib/ui/components/Toaster.svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	onMount(() => {
		preferences.load();
		applyTheme(preferences.theme);
		// iOS Safari only applies :active styles when a touch listener exists.
		document.addEventListener('touchstart', () => {}, { passive: true });
		// RUM after the page is interactive; never competes with hydration.
		const start = () => void startVitalsReporting();
		if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 3000 });
		else setTimeout(start, 1500);
	});
</script>

<svelte:head>
	<title>Performance Coach</title>
</svelte:head>

<a class="skip-link" href="#main">Skip to content</a>
{@render children()}
<Toaster />

<style>
	.skip-link {
		position: fixed;
		z-index: var(--z-toast);
		top: calc(var(--safe-top) + var(--space-2));
		left: var(--space-4);
		padding: var(--space-2) var(--space-4);
		border-radius: var(--radius-full);
		background: var(--color-accent);
		color: var(--color-on-accent);
		font-weight: var(--weight-semibold);
		transform: translateY(-200%);
	}

	.skip-link:focus-visible {
		transform: none;
	}
</style>
