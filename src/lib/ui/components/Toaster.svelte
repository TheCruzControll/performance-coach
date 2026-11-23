<!--
  @component
  Renders the toast queue in a polite live region (Paper, 10 · States): one line 10 px above the
  tab bar and the resume line, as wide as the column on a phone; from 1024 px at the column's
  foot, 40 px up and as wide as its words. A screen with chrome at its foot raises it through
  --toast-lift; the workout keeps it at the top until v2/10. Mount once in the root layout. Each
  line is a Toast.svelte, whose styles stay out of the stylesheet inlined into every page.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { toast, type ToastItem } from '../toast.svelte';
	import Toast from './Toast.svelte';

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
		<Toast {item} onleft={() => remove(item.id)} />
	{/each}
</div>

<style>
	/* Screen chrome at the foot: over the tab bar and the resume line (--nav-inset-bottom), and over
	   any chrome a screen keeps there (--toast-lift: the composer, a section's Save bar). Its lines
	   take no tap but Undo's and the ×'s (Toast.svelte). */
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

	/* At the top, a line sliding down (--toast-from, Toast.svelte): on the workout until v2/10,
	   whose logger is at the foot, and below 1024 px while a sheet, which covers the foot, is open. */
	:global(:root:has(main.workout)) .toaster {
		top: calc(var(--safe-top) + var(--space-3));
		bottom: auto;
		--toast-from: -16px;
	}

	@media (width < 64rem) {
		:global(:root:has(.sheet-dialog[open])) .toaster {
			top: calc(var(--safe-top) + var(--space-3));
			bottom: auto;
			--toast-from: -16px;
		}

		/* A section's Save bar: 60 px of Save and 12 px either side. Until v2/22 sets --toast-lift
		   in SectionScreen.svelte itself (docs/known-issues.md). */
		:global(:root:has(#main [data-testid='save-bar'])) {
			--toast-lift: calc(3.75rem + 2 * var(--space-3));
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
		/* Its line, 48 px with 14 px corners: here, where the build lowers the query for older
		   browsers, not in Toast.svelte's injected styles. */
		:global(:root:has(.app-nav)) .toaster > :global(.toast) {
			min-height: 3rem;
			border-radius: var(--radius-sm);
		}
	}
</style>
