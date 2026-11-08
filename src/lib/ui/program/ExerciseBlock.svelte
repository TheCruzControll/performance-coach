<!--
  @component
  One planned exercise: its name, its place in a superset ('A1'), what the coach says about it,
  and each set prescription as PrescriptionLines lays it out. It lays out session-words.ts's
  exerciseViews, whose lines are describe.ts's words in the owner's unit. The session screen adds
  an action beside the name (Swap) and, for an exercise swapped this session only, says so. In a
  wide column (WIDE_EXERCISE below) the coach's words sit beside the sets instead of around them.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Badge from '../components/Badge.svelte';
	import Surface from '../components/Surface.svelte';
	import PrescriptionLines from './PrescriptionLines.svelte';
	import type { ExerciseView } from './session-words.ts';

	interface Props {
		/** `swapped`: 'This session only' after a one-off swap. */
		exercise: ExerciseView & { swapped?: string | null };
		/** Beside the name: what can be done to it (the session screen's Swap). */
		action?: Snippet;
		'data-testid'?: string;
	}

	let { exercise, action, 'data-testid': testId }: Props = $props();
	const id = $props.id();
</script>

<Surface as="article" class="exercise-card" aria-labelledby={id} data-testid={testId}>
	<div class="exercise">
		<div class="head">
			<h3 {id} class="name">
				{#if exercise.label}<span class="label numeric"
						><span class="visually-hidden">Superset </span>{exercise.label}</span
					>{/if}
				{exercise.name}
			</h3>
			{@render action?.()}
		</div>
		{#if exercise.swapped}
			<div><Badge icon="refresh" data-testid="exercise-swapped">{exercise.swapped}</Badge></div>
		{/if}
		{#if exercise.instructions}<p class="note">{exercise.instructions}</p>{/if}
		<PrescriptionLines label={`${exercise.name}: sets`} sets={exercise.sets} />
		{#if exercise.notes}<p class="note">{exercise.notes}</p>{/if}
	</div>
</Surface>

<style>
	.exercise {
		display: grid;
		gap: var(--space-1);
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.name {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-tight);
		line-height: var(--leading-snug);
		overflow-wrap: anywhere;
	}

	.label {
		flex: none;
		padding: var(--space-0-5) var(--space-1-5);
		border-radius: var(--radius-sm);
		background: var(--color-surface-2);
		font-size: var(--text-xs);
		font-weight: var(--weight-bold);
		color: var(--color-text-secondary);
	}

	.note {
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		color: var(--color-text-secondary);
	}

	/* Its content adapts to the card's own width (the column it is in), never the window's. */
	:global(.exercise-card) {
		container-type: inline-size;
	}

	/*
	 * WIDE_EXERCISE: a card whose content is at least 35rem wide (the session's main column on a
	 * desktop, a readable column from 640 px) puts the coach's words in a column beside the sets,
	 * on a hairline, level with the first set. Above the phone column (34rem), so an iPhone never
	 * sees it; the type stays the same at every width.
	 */
	@container (min-width: 35rem) {
		.exercise:has(> .note) {
			grid-template-columns: minmax(0, 1fr) minmax(0, 15rem);
			grid-auto-flow: row dense;
			column-gap: var(--space-6);
		}

		.exercise > :global(*) {
			grid-column: 1 / -1;
		}

		.exercise:has(> .note) > :global(ol) {
			grid-column: 1;
			grid-row: span 2;
		}

		.exercise > .note {
			grid-column: 2;
			align-self: start;
			margin-top: var(--space-3);
			padding-left: var(--space-4);
			border-left: 1px solid var(--color-hairline);
		}
	}
</style>
