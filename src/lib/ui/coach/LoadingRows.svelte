<!--
  @component
  The coach's loading placeholder: skeleton rows the shape of conversations or messages, under a
  container marked aria-busy with words for screen readers. The shimmer holds still under reduced
  motion (Skeleton).
-->
<script lang="ts">
	import Skeleton from '../components/Skeleton.svelte';

	interface Props {
		/** What is loading, for screen readers: 'Loading your conversations…'. */
		label: string;
		rows?: number;
		'data-testid'?: string;
	}

	let { label, rows = 3, 'data-testid': testId }: Props = $props();
	// Ragged lines, so the rows read as text rather than as bars.
	const WIDTHS = ['72%', '54%', '64%', '46%'];
	const lines = $derived(Array.from({ length: rows }, (_, i) => WIDTHS[i % WIDTHS.length]!));
</script>

<div class="rows" role="status" aria-busy="true" data-testid={testId}>
	<span class="visually-hidden">{label}</span>
	{#each lines as width, i (i)}
		<div class="row">
			<Skeleton circle height="2.25rem" />
			<div class="lines">
				<Skeleton height="0.875rem" {width} />
				<Skeleton height="0.75rem" width="32%" />
			</div>
		</div>
	{/each}
</div>

<style>
	.rows {
		display: grid;
		gap: var(--space-2);
	}

	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: 3.5rem;
		padding: var(--space-2) var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
	}

	.lines {
		display: grid;
		flex: 1;
		gap: var(--space-2);
	}
</style>
