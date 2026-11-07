<!--
  @component
  The toasts inside Toaster's live region. Toaster loads it on demand.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { toast, type ToastItem } from '../toast.svelte';
	import Icon from './Icon.svelte';

	// A dismissed toast stays, inert, until it has slid out. CSS animations, not svelte/transition:
	// its runtime would sit in the framework chunk every route loads, for this one component.
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

{#each shown as item (item.id)}
	<div
		class="toast"
		data-tone={item.tone}
		data-leaving={item.leaving}
		inert={item.leaving}
		onanimationend={() => item.leaving && remove(item.id)}
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

<style>
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
