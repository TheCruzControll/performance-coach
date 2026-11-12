<!--
  @component
  A proposal on its way: skeleton lines the shape of its card (a title, then what changes and
  why), under a container marked aria-busy with words for screen readers. The inbox's own, so it
  shares no chunk with the Coach screen's loading rows (docs/performance.md). The shimmer holds
  still under reduced motion (Skeleton).
-->
<script lang="ts">
	import Skeleton from '#lib/ui/components/Skeleton.svelte';

	let { 'data-testid': testId }: { 'data-testid'?: string } = $props();
</script>

<div class="pending" role="status" aria-busy="true" data-testid={testId}>
	<span class="visually-hidden">Loading the proposal…</span>
	<Skeleton height="0.75rem" width="28%" />
	<Skeleton height="1.25rem" width="64%" />
	{#each ['88%', '72%', '80%'] as width (width)}<Skeleton height="0.875rem" {width} />{/each}
</div>

<style>
	.pending {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
	}
</style>
