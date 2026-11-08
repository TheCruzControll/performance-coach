<!--
  @component
  Renders the toast queue in a polite live region at the top of the viewport (clear of the
  thumb zone and the bottom navigation), centred over the content column beside the rail. Mount
  once in the root layout.
-->
<script lang="ts">
	import { onMount, untrack, type Component } from 'svelte';
	import { toast } from '../toast.svelte';

	// The toasts themselves (ToastList) are no route's initial JS: they load once the page is
	// idle, or at the first toast if that is sooner. The live region is in the page from the
	// start, so the first toast is announced like any other, and its time on screen starts when it
	// appears (toast.appeared). Left out of the server build, which renders no toast: while the
	// server can reach ToastList, SvelteKit links its CSS into every page.
	let List = $state<Component>();
	// Offline, or once ToastList has failed to load, the toasts show as plain text.
	let plain = $state(false);
	let loading = false;
	async function load() {
		if (List || loading || import.meta.env.SSR) return;
		// Not fetched offline: Chromium keeps a failed module fetch's error for the page's life.
		if (!navigator.onLine) return waitOnline();
		loading = true;
		try {
			// Awaited, not `.then`: Vite moves a `.then` into its preload wrapper, which rejects
			// before the import runs when a stylesheet fails, so that `.then` never heard of it.
			List = (await import('./ToastList.svelte')).default;
		} catch {
			waitOnline();
		} finally {
			loading = false;
		}
	}
	function waitOnline() {
		plain = true;
		addEventListener('online', load, { once: true });
	}

	onMount(() => {
		if ('requestIdleCallback' in window) requestIdleCallback(load, { timeout: 3000 });
		else setTimeout(load, 1500);
	});

	$effect(() => {
		if (toast.items.length) void load();
	});
</script>

<div class="toaster" role="status" aria-live="polite" aria-atomic="false">
	{#if List}
		<List />
	{:else if plain}
		{#each toast.items as item (item.id)}
			<div
				class="toast"
				data-tone={item.tone}
				{@attach () => untrack(() => toast.appeared(item.id))}
			>
				<p class="message">{item.message}</p>
				{#if item.action}
					<button
						type="button"
						class="action"
						onclick={() => {
							item.action?.onclick();
							toast.dismiss(item.id);
						}}>{item.action.label}</button
					>
				{/if}
			</div>
		{/each}
	{/if}
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

	/* ToastList's styles live here, in every page's CSS: the plain-text toasts above need them,
	   and a stylesheet that failed to load offline is never asked for again. */
	.toaster :global(.toast) {
		pointer-events: auto;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
		min-height: 3.25rem;
		border-radius: var(--radius-lg);
		background: var(--color-surface-inverse);
		color: var(--color-text-inverse);
		box-shadow: var(--elevation-3);
		/* Ease-out-cubic in; the same curve reversed (ease-in-cubic) out. */
		animation: toast-in 260ms cubic-bezier(0.33, 1, 0.68, 1);
	}
	.toaster :global(.toast[data-leaving]) {
		animation: toast-out 260ms cubic-bezier(0.32, 0, 0.67, 0) forwards;
	}
	@keyframes toast-in {
		from {
			opacity: 0;
			transform: translateY(-16px);
		}
	}
	@keyframes toast-out {
		to {
			opacity: 0;
			transform: translateY(-16px);
		}
	}

	.toaster :global(.toast[data-tone='positive'] .icon) {
		color: var(--color-positive);
	}
	.toaster :global(.toast[data-tone='danger'] .icon:first-child) {
		color: var(--color-danger);
	}

	.toaster :global(.message) {
		flex: 1;
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		line-height: var(--leading-snug);
	}

	.toaster :global(.action) {
		min-height: var(--touch-target);
		padding: 0 var(--space-2);
		font-size: var(--text-sm);
		font-weight: var(--weight-bold);
		color: inherit;
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.toaster :global(.dismiss) {
		display: grid;
		place-items: center;
		width: var(--touch-target);
		height: var(--touch-target);
		border-radius: var(--radius-full);
		opacity: 0.6;
	}
	.toaster :global(.dismiss:active) {
		opacity: 1;
	}
</style>
