<!--
  @component
  Quiet outlined label for a category, e.g. a discipline. An optional discipline `tone` adds a
  small colour dot (a signal, never a fill). Static by design: chips that filter or toggle will
  be a SegmentedControl or a button group, not this.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		tone?: 'strength' | 'running' | 'combat' | 'hypertrophy' | 'conditioning';
		as?: 'span' | 'li';
		children: Snippet;
	}

	let { tone, as = 'span', children }: Props = $props();
</script>

<svelte:element this={as} class="chip">
	{#if tone}<span class="dot" style:background={`var(--color-${tone})`} aria-hidden="true"
		></span>{/if}
	{@render children()}
</svelte:element>

<style>
	.chip {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1-5);
		/* 28 px: a size, not spacing. tokens.css has no size scale, so this stays a literal. */
		min-height: 1.75rem;
		padding: 0 var(--space-2);
		border-radius: var(--radius-sm);
		border: 1px solid var(--color-border);
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		font-weight: var(--weight-regular);
		color: var(--color-text-secondary);
		white-space: nowrap;
	}

	/* A 6 px square-ish signal, not a circle (no pills, no circles). */
	.dot {
		width: 6px;
		height: 6px;
		border-radius: var(--radius-xs);
	}
</style>
