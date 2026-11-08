<!--
  @component
  A Muay Thai, mobility, S&C or custom session's own metrics (rounds, techniques, whatever the
  session recorded), each a label and its value, in words composed on the server.
-->
<script lang="ts">
	import Section from '#lib/ui/components/Section.svelte';
	import type { WorkoutDetailView } from './history.server';

	let { metrics }: { metrics: WorkoutDetailView['metrics'] } = $props();
</script>

<Section title="Metrics" data-testid="workout-metrics">
	<dl class="metrics">
		{#each metrics as metric (metric.key)}
			<div class="metric">
				<dt>{metric.label}</dt>
				<dd class="numeric">{metric.value}</dd>
			</div>
		{/each}
	</dl>
</Section>

<style>
	.metrics {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
		gap: var(--space-2);
		margin: 0;
	}

	.metric {
		display: grid;
		gap: var(--space-1);
		padding: var(--space-3);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		background: var(--color-surface-1);
	}

	dt {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	dd {
		margin: 0;
		font-weight: var(--weight-semibold);
	}
</style>
