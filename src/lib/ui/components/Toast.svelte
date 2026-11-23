<svelte:options css="injected" />

<!--
  @component
  One toast line, for Toaster.svelte only (Paper, 10 · States): a 52 px surface-2 line with 16 px
  corners and 20 px either side, 18 with a danger toast's leading alert; a plain line, with no
  alert, Undo or ×, is centred ("It worked"). Undo is a strong text link at the end (base.css
  .text-link[data-strong]); only a toast that stays until it is dismissed has a 44 px ×, which
  takes the end padding down to 4. The words and Undo are both secondary, in the line's font.
  Only Undo and the × take a tap; the rest reaches the screen under it. It slides in on an
  ease-out-cubic curve and out on the same curve reversed (ease-in-cubic), from --toast-from
  (Toaster's: up from the foot, down from the top). A leaving toast is inert until it has slid
  out, then calls `onleft`. Every line takes the Toaster's one grid cell, so a leaving toast and
  the next share one place; the Toaster sets its desktop size (48 px, 14 px corners).

  Its styles are injected when the first toast mounts, not linked or inlined: nothing on a page
  needs them before then, and the root layout's stylesheet, inlined into every page, stays under
  SvelteKit's inlineStyleThreshold (scripts/check-budgets.ts). They are kept short and without
  comments, which would ship in the JS, and without media queries, which the build would not
  lower for older browsers here. The component is in the framework chunk with Toaster, so a toast
  never waits on the network for them.
-->
<script lang="ts">
	import { toast, type ToastItem } from '../toast.svelte';
	import Icon from './Icon.svelte';

	interface Props {
		item: ToastItem & { leaving?: boolean };
		onleft: () => void;
	}

	let { item, onleft }: Props = $props();
</script>

<div
	class="toast"
	data-tone={item.tone}
	data-leaving={item.leaving}
	inert={item.leaving}
	onanimationend={() => item.leaving && onleft()}
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
	{#if item.duration <= 0}
		<button
			type="button"
			class="dismiss"
			aria-label="Dismiss notification"
			onclick={() => toast.dismiss(item.id)}
		>
			<Icon name="close" size={18} />
		</button>
	{/if}
</div>

<style>
	.toast {
		grid-area: 1 / 1;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: 3.25rem;
		padding: 0 var(--space-5);
		border-radius: var(--radius-md);
		background: var(--color-surface-2);
		color: var(--color-text);
		font: var(--type-secondary);
		animation: toast-in 260ms cubic-bezier(0.33, 1, 0.68, 1);
	}
	.toast[data-tone='danger'] {
		padding-inline: var(--space-4-5);
	}
	.toast:has(.dismiss) {
		padding-right: var(--space-1);
	}
	.toast[data-leaving] {
		animation: toast-out 260ms cubic-bezier(0.32, 0, 0.67, 0) forwards;
	}
	@keyframes toast-in {
		from {
			opacity: 0;
			transform: translateY(var(--toast-from, 16px));
		}
	}
	@keyframes toast-out {
		to {
			opacity: 0;
			transform: translateY(var(--toast-from, 16px));
		}
	}

	.alert {
		display: grid;
		flex: none;
		color: var(--color-danger);
	}

	.message {
		flex: 1;
	}
	.message:only-child {
		text-align: center;
	}

	button {
		pointer-events: auto;
	}

	.action {
		min-height: var(--touch-target);
		padding-left: var(--space-2);
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
