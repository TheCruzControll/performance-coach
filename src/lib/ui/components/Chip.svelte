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
		min-height: 1.75rem;
		padding: 0 var(--space-3);
		border-radius: var(--radius-full);
		border: 1px solid var(--color-border);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
		white-space: nowrap;
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
	}
</style>
