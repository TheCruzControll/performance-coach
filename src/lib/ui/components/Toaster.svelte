<!--
  @component
  Renders the toast queue in a polite live region (Paper, 10 · States): one line 10 px above the
  tab bar and the resume line, as wide as the column on a phone; from 1024 px at the column's
  foot, 40 px up and as wide as its words. A screen with chrome at its foot raises it through
  --toast-lift; the workout keeps it at the top until v2/10. Mount once in the root layout. A
  surface-2 line; only a danger toast has a leading icon; an undo is a strong text link at the
  end; only a toast that stays until it is dismissed has a ×.
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
	{/each}
</div>

<style>
	/* Screen chrome at the foot: over the tab bar and the resume line (--nav-inset-bottom), and over
	   any chrome a screen keeps there (--toast-lift: the composer, a section's Save bar). */
	.toaster {
		position: fixed;
		z-index: var(--z-toast);
		bottom: calc(
			max(var(--nav-inset-bottom), var(--safe-bottom)) + var(--toast-lift, 0px) + var(--space-2-5)
		);
		left: calc(50% + var(--nav-inset-left) / 2);
		transform: translateX(-50%);
		width: min(calc(100% - var(--nav-inset-left) - 2 * var(--gutter)), var(--content-column));
		display: grid;
		pointer-events: none;
	}

	/* A section's Save bar below 1024 px: 60 px of Save and 12 px either side. Until v2/22 sets
	   --toast-lift in SectionScreen.svelte itself (docs/known-issues.md). */
	@media (width < 64rem) {
		:global(:root:has(#main [data-testid='save-bar'])) {
			--toast-lift: calc(3.75rem + 2 * var(--space-3));
		}
	}

	/* The workout keeps its toasts at the top until v2/10: its logger is at the foot. */
	:global(:root:has(main.workout)) .toaster {
		top: calc(var(--safe-top) + var(--space-3));
		bottom: auto;
	}

	/* Below 1024 px an open sheet covers the foot, so a toast stays at the top while it is open. */
	@media (width < 64rem) {
		:global(:root:has(.sheet-dialog[open])) .toaster {
			top: calc(var(--safe-top) + var(--space-3));
			bottom: auto;
		}
		:global(:root:has(.sheet-dialog[open])) .toast {
			--toast-from: -16px;
		}
	}

	/* From 1024 px in the shell: at the column's foot, starting where its text does, as wide as
	   its words (Paper, 14 · State, toast: left 288, 40 px over the window's foot). */
	@media (width >= 64rem) {
		:global(:root:has(.app-nav)) .toaster {
			left: calc(var(--column-start) + var(--gutter));
			width: calc(var(--column-width) - 2 * var(--gutter));
			bottom: calc(var(--nav-inset-bottom) + var(--toast-lift, 0px) + var(--space-10));
			transform: none;
			justify-items: start;
		}
	}

	/* One at a time: a leaving toast and the next share one place. A tap on the words reaches
	   the screen under them; only Undo or the × take one. */
	.toast {
		grid-area: 1 / 1;
		pointer-events: none;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: 3.25rem; /* 52, Paper */
		padding: 0 var(--space-5); /* 20: the line and an Undo (Paper) */
		border-radius: var(--radius-md); /* 16 */
		background: var(--color-surface-2);
		color: var(--color-text);
		box-shadow: none;
		/* Ease-out-cubic in; the same curve reversed (ease-in-cubic) out. */
		animation: toast-in 260ms cubic-bezier(0.33, 1, 0.68, 1);
	}
	.toast[data-tone='danger'] {
		padding-inline: var(--space-4-5); /* 18, with the alert (Paper) */
	}
	/* A plain line is centred in it (Paper, "It worked"). */
	.toast:not([data-tone='danger']):not(:has(.action, .dismiss)) .message {
		text-align: center;
	}
	.toast:has(.dismiss) {
		padding-right: var(--space-1);
	}
	.toast[data-leaving] {
		animation: toast-out 260ms cubic-bezier(0.32, 0, 0.67, 0) forwards;
	}
	:global(:root:has(main.workout)) .toast {
		--toast-from: -16px;
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

	@media (width >= 64rem) {
		:global(:root:has(.app-nav)) .toast {
			min-height: 3rem; /* 48 */
			border-radius: var(--radius-sm); /* 14 */
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

	.action,
	.dismiss {
		pointer-events: auto;
	}

	/* A strong text link (base.css .text-link[data-strong]): 600, underlined in its own colour. */
	.action {
		min-height: var(--touch-target);
		padding: 0 0 0 var(--space-2);
		font: var(--type-secondary);
		font-weight: var(--weight-semibold);
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
