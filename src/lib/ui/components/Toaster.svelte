<!--
  @component
  Renders the toast queue in a polite live region at the top of the viewport (clear of the
  thumb zone and the bottom navigation), centred over the content column beside the rail. Mount
  once in the root layout. Instrument v2: a surface-2 line; only a danger toast has a leading
  icon; an undo is a strong text link at the end.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { toast, type ToastItem } from '../toast.svelte';
	import Icon from './Icon.svelte';

	// Part of every route's initial JS, not loaded on demand: a toast must never wait on the
	// network (docs/performance.md). A dismissed toast stays, inert, until it has slid out. CSS
	// animations, not svelte/transition: its runtime would sit in the framework chunk every route
	// loads, for this one component.
	let shown = $state<(ToastItem & { leaving?: boolean })[]>([]);
	$effect.pre(() => {
		const live = new Map(toast.items.map((item) => [item.id, item]));
		const kept = untrack(() => shown).map(
			(item) => live.get(item.id) ?? { ...item, leaving: true }
		);
		const known = new Set(kept.map((item) => item.id));
		const added = toast.items.filter((item) => !known.has(item.id));
		shown = [...kept, ...added];
		for (const item of added) toast.appeared(item.id);
	});
	const remove = (id: number) => (shown = shown.filter((item) => item.id !== id));
</script>

<div class="toaster" role="status" aria-live="polite" aria-atomic="false">
	{#each shown as item (item.id)}
		<div
			class="toast"
			data-tone={item.tone}
			data-leaving={item.leaving}
			inert={item.leaving}
			onanimationend={() => item.leaving && remove(item.id)}
		>
			{#if item.tone === 'danger'}
				<span class="alert"><Icon name="alert" size={20} /></span>
			{/if}
			<p class="message">{item.message}</p>
			{#if item.action}
				<button
					type="button"
					class="action text-link"
					data-strong
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

	/* A surface-2 line of 52 px: the 44 px dismiss is the tallest thing in it. */
	.toast {
		pointer-events: auto;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-1) var(--space-1) var(--space-1) var(--space-4-5);
		min-height: 3.25rem;
		border-radius: var(--radius-md);
		background: var(--color-surface-2);
		color: var(--color-text);
		box-shadow: none;
		/* Ease-out-cubic in; the same curve reversed (ease-in-cubic) out. */
		animation: toast-in 260ms cubic-bezier(0.33, 1, 0.68, 1);
	}
	.toast[data-leaving] {
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

	.alert {
		display: grid;
		flex: none;
		color: var(--color-danger);
	}

	.message {
		flex: 1;
		font: var(--type-secondary);
	}

	/* A strong text link (base.css .text-link[data-strong]): 600, underlined in its own colour. */
	.action {
		min-height: var(--touch-target);
		padding: 0 var(--space-2);
		font: var(--type-secondary);
	}

	.dismiss {
		display: grid;
		flex: none;
		place-items: center;
		width: var(--touch-target);
		height: var(--touch-target);
		border-radius: var(--radius-full);
		color: var(--color-text-tertiary);
	}
</style>
