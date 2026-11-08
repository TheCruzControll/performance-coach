<!--
  @component
  The current exercise of a strength workout, readable mid-set (PRD §7):
  - its place ('Exercise 4 of 5'), its superset label ('A1') and its name
  - the kit's prescription lines (M3's describe headlines, '3 × 10 @ RPE 7'), rendered as given
  - the load for the set at hand (set-words.ts's loadLine): the prescribed weight, the baseline
    instruction, or what the load type means ('Bodyweight · add weight if you like'); never an
    invented number
  - the rest, then the previous session's sets inline for comparison; without any, `noPrevious`
    says why ('Last time · none yet', or 'No previous sets on this device' for a substitute whose
    last session could not be fetched)
  - its slot's state once it changed ('Swapped for this session', 'Skipped'), with the exercise
    it replaced, and its quick actions (the `actions` snippet) beside the name
  The load and the rest keep the room of the exercise's tallest, so logging a set moves nothing.
  - its set rows (the children: SetRows)
  Long names wrap; nothing scrolls sideways at 393 px or at 150 % text. One per page: its heading's
  id is fixed ('exercise-name').
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ExerciseWords } from './set-words.ts';

	interface Props {
		exercise: ExerciseWords;
		/** The slot's state in words, and the exercise it replaced; none as planned. */
		status?: { text: string; instead: string | null } | null;
		/** What Last time says without previous sets. */
		noPrevious?: string;
		/** Its quick actions' button. */
		actions?: Snippet;
		/** Its set rows (SetRows). */
		children: Snippet;
	}

	let {
		exercise,
		status = null,
		noPrevious = 'Last time · none yet',
		actions,
		children
	}: Props = $props();
</script>

<section class="card" aria-labelledby="exercise-name" data-testid="exercise">
	<header class="head">
		<p class="place">
			{#if exercise.label}<span class="badge">{exercise.label}</span>{/if}
			<span>{exercise.place}</span>
		</p>
		<div class="title">
			<h2 id="exercise-name">{exercise.name}</h2>
			{@render actions?.()}
		</div>
		{#if status}
			<p class="state" data-testid="slot-state">
				<strong>{status.text}</strong>{#if status.instead}<span>Instead of {status.instead}</span
					>{/if}
			</p>
		{/if}
	</header>

	<div class="target" data-testid="exercise-target">
		<p class="lines">{exercise.lines.join(' · ')}</p>
		<!-- The set at hand's load and rest, each over a ghost of every set's, so logging a set never
		     moves what follows. A ghost's words are generated content, outside the text. -->
		<div class="stack">
			{#if exercise.load}
				<p class="load" data-kind={exercise.load.kind}>{exercise.load.text}</p>
			{/if}
			{#each exercise.loads as load, i (i)}
				{#if load}<p class="load ghost" data-kind={load.kind} data-text={load.text}></p>{/if}
			{/each}
		</div>
		<div class="stack">
			{#if exercise.rest}<p class="rest">{exercise.rest}</p>{/if}
			{#each exercise.rests as rest, i (i)}
				{#if rest}<p class="rest ghost" data-text={rest}></p>{/if}
			{/each}
		</div>
	</div>

	<div class="previous" data-testid="exercise-previous">
		<h3>{exercise.previous?.heading ?? noPrevious}</h3>
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

	.title {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.state {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-2);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.state strong {
		color: var(--color-accent-text);
		font-weight: var(--weight-semibold);
	}

	h2 {
		flex: 1;
		min-width: 0;
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

	.stack {
		display: grid;
		align-items: start;
	}

	.stack:not(:has(p)) {
		display: none;
	}

	.stack > * {
		grid-area: 1 / 1;
	}

	.ghost {
		visibility: hidden;
	}

	.ghost::before {
		content: attr(data-text);
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
