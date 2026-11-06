<!--
  @component
  One planned exercise: its name, its place in a superset ('A1'), what the coach says about it,
  and each set prescription as PrescriptionLines lays it out. It lays out session-words.ts's
  exerciseViews, whose lines are describe.ts's words in the owner's unit.
-->
<script lang="ts">
	import Surface from '../components/Surface.svelte';
	import PrescriptionLines from './PrescriptionLines.svelte';
	import type { ExerciseView } from './session-words.ts';

	interface Props {
		exercise: ExerciseView;
		'data-testid'?: string;
	}

	let { exercise, 'data-testid': testId }: Props = $props();
	const id = $props.id();
</script>

<Surface as="article" aria-labelledby={id} data-testid={testId}>
	<div class="exercise">
		<h3 {id} class="name">
			{#if exercise.label}<span class="label numeric"
					><span class="visually-hidden">Superset </span>{exercise.label}</span
				>{/if}
			{exercise.name}
		</h3>
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

	.name {
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
</style>
