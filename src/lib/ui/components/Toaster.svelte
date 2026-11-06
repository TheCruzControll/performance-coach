<!--
  @component
  Renders the toast queue in a polite live region at the top of the viewport (clear of the
  thumb zone and the bottom navigation), centred over the content column beside the rail. Mount
  once in the root layout.
-->
<script lang="ts">
	import { fly } from 'svelte/transition';
	import { toast } from '../toast.svelte';
	import Icon from './Icon.svelte';

	const reduceMotion =
		typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
</script>

<div class="toaster" role="status" aria-live="polite" aria-atomic="false">
	{#each toast.items as item (item.id)}
		<div
			class="toast"
			data-tone={item.tone}
			transition:fly={{ y: reduceMotion ? 0 : -16, duration: reduceMotion ? 0 : 260 }}
		>
			<Icon
				name={item.tone === 'danger' ? 'alert' : item.tone === 'positive' ? 'check' : 'info'}
				size={20}
			/>
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
			<button
				type="button"
				class="dismiss"
				aria-label="Dismiss notification"
				onclick={() => toast.dismiss(item.id)}
			>
				<Icon name="close" size={18} />
			</button>
		</div>
	{/each}
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

	.toast {
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
	}

	.toast[data-tone='positive'] :global(.icon) {
		color: var(--color-positive);
	}
	.toast[data-tone='danger'] :global(.icon:first-child) {
		color: var(--color-danger);
	}

	.message {
		flex: 1;
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		line-height: var(--leading-snug);
	}

	.action {
		min-height: var(--touch-target);
		padding: 0 var(--space-2);
		font-size: var(--text-sm);
		font-weight: var(--weight-bold);
		color: inherit;
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.dismiss {
		display: grid;
		place-items: center;
		width: var(--touch-target);
		height: var(--touch-target);
		border-radius: var(--radius-full);
		opacity: 0.6;
	}
	.dismiss:active {
		opacity: 1;
	}
</style>
