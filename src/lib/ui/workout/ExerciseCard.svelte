<!--
  @component
  The current exercise of a strength workout, readable mid-set (PRD §7):
  - its place ('Exercise 4 of 5'), its superset label ('A1') and its name
  - the kit's prescription lines (M3's describe headlines, '3 × 10 @ RPE 7'), rendered as given
  - the load for the set at hand (set-words.ts's loadLine): the prescribed weight, the baseline
    instruction, or what the load type means ('Bodyweight · add weight if you like'); never an
    invented number
  - the rest, then the previous session's sets inline for comparison
  - its set rows (the children: SetRows)
  Long names wrap; nothing scrolls sideways at 393 px or at 150 % text. One per page: its heading's
  id is fixed ('exercise-name').
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ExerciseWords } from './set-words.ts';

	interface Props {
		exercise: ExerciseWords;
		/** Its set rows (SetRows). */
		children: Snippet;
	}

	let { exercise, children }: Props = $props();
</script>

<section class="card" aria-labelledby="exercise-name" data-testid="exercise">
	<header class="head">
		<p class="place">
			{#if exercise.label}<span class="badge">{exercise.label}</span>{/if}
			<span>{exercise.place}</span>
		</p>
		<h2 id="exercise-name">{exercise.name}</h2>
	</header>

	<div class="target" data-testid="exercise-target">
		<p class="lines">{exercise.lines.join(' · ')}</p>
		{#if exercise.load}
			<p class="load" data-kind={exercise.load.kind}>{exercise.load.text}</p>
		{/if}
		{#if exercise.rest}<p class="rest">{exercise.rest}</p>{/if}
	</div>

	<div class="previous" data-testid="exercise-previous">
		<h3>{exercise.previous?.heading ?? 'Last time · none yet'}</h3>
		{#if exercise.previous}
			<ol class="chips">
				{#each exercise.previous.sets as set, i (i)}<li>{set}</li>{/each}
			</ol>
		{/if}
	</div>

	<ol class="sets" aria-label="Sets">
		{@render children()}
	</ol>
</section>

<style>
	ol {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.card {
		display: grid;
		gap: var(--space-4);
		padding: var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
		box-shadow: var(--elevation-1);
	}

	.head {
		display: grid;
		gap: var(--space-1);
	}

	.place {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.badge {
		display: inline-grid;
		place-items: center;
		min-width: 2rem;
		padding: var(--space-0-5) var(--space-1-5);
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--color-strength) 16%, transparent);
		color: var(--color-text);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
	}

	h2 {
		font-family: var(--font-display);
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-tight);
		line-height: var(--leading-snug);
		overflow-wrap: anywhere;
	}

	.target {
		display: grid;
		gap: var(--space-1-5);
	}

	.lines {
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
		line-height: var(--leading-snug);
	}

	.load {
		color: var(--color-text-secondary);
		line-height: var(--leading-normal);
	}

	.load[data-kind='weight'] {
		font-family: var(--font-numeric);
		font-size: var(--text-3xl);
		font-weight: var(--weight-bold);
		color: var(--color-text);
		font-variant-numeric: lining-nums proportional-nums;
	}

	.rest {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.previous {
		display: grid;
		gap: var(--space-2);
		padding-top: var(--space-3);
		border-top: 1px solid var(--color-hairline);
	}

	h3 {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--color-text-secondary);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1-5);
	}

	.chips li {
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius-sm);
		background: var(--color-surface-2);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	.sets {
		display: grid;
		gap: var(--space-1);
	}
</style>
