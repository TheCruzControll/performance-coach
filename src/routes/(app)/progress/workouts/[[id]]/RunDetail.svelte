<!--
  @component
  A run's segments as run, in order: each one's kind and its distance, time, pace in the owner's
  unit, heart rate and RPE, in words composed on the server (history.server.ts).
-->
<script lang="ts">
	import Section from '#lib/ui/components/Section.svelte';
	import type { WorkoutDetailView } from './history.server';

	let { segments }: { segments: WorkoutDetailView['segments'] } = $props();
</script>

<Section title="Segments" data-testid="workout-segments">
	<ol class="segments">
		{#each segments as segment (segment.key)}
			<li class="segment" data-testid="workout-segment">
				<span class="kind">{segment.label}</span>
				<span class="line numeric">{segment.value}</span>
			</li>
		{/each}
	</ol>
</Section>

<style>
	.segments {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* A dot per segment on a rail, as the planned run's timeline draws it. */
	.segment {
		position: relative;
		display: grid;
		gap: var(--space-0-5);
		padding: var(--space-2) 0 var(--space-2) var(--space-5);
	}

	.segment::before {
		content: '';
		position: absolute;
		top: calc(var(--space-2) + 0.4rem);
		left: 0.125rem;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: var(--radius-full);
		background: var(--color-running);
	}

	.segment:not(:last-child)::after {
		content: '';
		position: absolute;
		top: calc(var(--space-2) + 1.1rem);
		bottom: calc(var(--space-2) * -1 + 0.4rem);
		left: calc(0.375rem - 1px);
		width: 2px;
		background: var(--color-hairline);
	}

	.kind {
		font-weight: var(--weight-semibold);
	}

	.line {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}
</style>
