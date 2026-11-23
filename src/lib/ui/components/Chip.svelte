<!--
  @component
  Quiet label for a category, e.g. a discipline: plain secondary text. An optional discipline
  `tone` adds a small colour dot (a signal, never a fill). Static by design: chips that filter or
  toggle will be a SegmentedControl or a button group, not this. Legacy in v2: no new use; screen
  rows remove it.
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
	/* No outline and no pill. The 1 px the border took stays in the inline padding, so the text
	   keeps its place. */
	.chip {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1-5);
		min-height: 1.75rem;
		padding: 0 calc(var(--space-3) + 1px);
		border: 0;
		font: var(--type-secondary);
		color: var(--color-text-secondary);
		white-space: nowrap;
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
	}
</style>
