<!--
  @component
  Renders the toast queue in a polite live region at the top of the viewport (clear of the
  thumb zone and the bottom navigation), centred over the content column beside the rail. Mount
  once in the root layout.
-->
<script lang="ts">
	import { onMount, type Component } from 'svelte';
	import { toast } from '../toast.svelte';

	// The toasts themselves (ToastList) are no route's initial JS: they load once the page is
	// idle, or at the first toast if that is sooner. The live region is in the page from the
	// start, so the first toast is announced like any other, and its time on screen starts when it
	// appears (toast.appeared). Left out of the server build, which renders no toast: while the
	// server can reach ToastList, SvelteKit links its CSS into every page.
	let List = $state<Component>();
	let loading = false;
	function load() {
		if (loading) return;
		loading = true;
		if (import.meta.env.SSR) return;
		import('./ToastList.svelte').then(
			(module) => (List = module.default),
			() => (loading = false) // the next toast tries again
		);
	}

	// The idle load waits out an offline spell: WebKit keeps a failed import's error for the page's
	// life, so a load tried offline would leave every later toast unshown.
	function loadOnline() {
		if (navigator.onLine) load();
		else addEventListener('online', load, { once: true });
	}

	onMount(() => {
		if ('requestIdleCallback' in window) requestIdleCallback(loadOnline, { timeout: 3000 });
		else setTimeout(loadOnline, 1500);
	});

	$effect(() => {
		if (toast.items.length) load();
	});
</script>

<div class="toaster" role="status" aria-live="polite" aria-atomic="false">
	{#if List}<List />{/if}
</div>

<style>
	.toaster {
		position: fixed;
		z-index: var(--z-toast);
		top: calc(var(--safe-top) + var(--space-3));
		/* Screen chrome: centred over the content column, clear of the rail. */
		left: calc(50% + var(--nav-inset-left) / 2);
		transform: translateX(-50%);
		width: min(calc(100% - var(--nav-inset-left) - 2 * var(--space-4)), var(--content-column));
		display: grid;
		gap: var(--space-2);
		pointer-events: none;
	}
</style>
