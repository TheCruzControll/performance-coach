<script lang="ts">
	import { onMount } from 'svelte';
	import { startVitalsReporting } from '#lib/client/vitals.ts';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// Signed in (owner only), so real-user monitoring runs here as in the app shell.
	onMount(() => {
		const start = () => void startVitalsReporting();
		if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 3000 });
		else setTimeout(start, 1500);
	});
</script>

<div class="onboarding">
	<main id="main" class="content" tabindex="-1">
		{@render children()}
	</main>
</div>

<style>
	.onboarding {
		position: relative;
		min-height: 100dvh;
		padding-top: var(--safe-top);
		isolation: isolate;
	}

	/* The same quiet volt glow as the app shell: one product, not a separate wizard. */
	.onboarding::before {
		content: '';
		position: absolute;
		z-index: -1;
		inset: 0 0 auto;
		height: 20rem;
		pointer-events: none;
		background: radial-gradient(
			120% 70% at 50% -20%,
			color-mix(in srgb, var(--color-accent) 8%, transparent),
			transparent 70%
		);
	}

	.content {
		width: 100%;
		max-width: var(--content-max);
		margin: 0 auto;
		padding: 0 max(var(--gutter), var(--safe-right)) 0 max(var(--gutter), var(--safe-left));
		outline: none;
	}
</style>
