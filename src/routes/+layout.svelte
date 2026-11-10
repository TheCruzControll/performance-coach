<script lang="ts">
	import '#lib/ui/styles/app.css';
	import { onMount } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { setErrorContext } from '#lib/client/errors.ts';
	import { registerServiceWorkerWhenIdle } from '#lib/client/service-worker.ts';
	import { noteNavigation } from '#lib/client/visits.ts';
	import Toaster from '#lib/ui/components/Toaster.svelte';
	import type { LayoutProps } from './$types';
	import { loadErrorPage } from './error-page.ts';

	let { children }: LayoutProps = $props();

	// RUM attribution: remember which screen is showing (the landing page counts from t=0).
	// Read `page`, not `to.route`: SvelteKit 3.1's initial 'enter' navigation reports
	// `to.route.id === null` (it is built before the router state is assigned).
	afterNavigate(({ type }) => {
		noteNavigation(page.url.pathname, page.route.id, type === 'enter' ? 0 : undefined);
		setErrorContext(page.route.id);
	});

	onMount(() => {
		void import('#lib/client/preferences-start.ts').then((module) => module.startPreferences());
		// iOS Safari only applies :active styles when a touch listener exists.
		document.addEventListener('touchstart', () => {}, { passive: true });
		// After hydration, not on `load`, which comes before it (src/lib/client/service-worker.ts).
		registerServiceWorkerWhenIdle();
		// The root error page loads on demand; have it here before an error needs it, as
		// SvelteKit's own eager import did, but after hydration (src/routes/error-page.ts).
		loadErrorPage();
		// RUM starts in the signed-in app shell ((app)/+layout.svelte): /api/vitals needs a session.
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
