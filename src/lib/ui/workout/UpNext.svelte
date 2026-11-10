<!--
  @component
  Up next on the strength view (PRD §7): the exercise the flow names next and its first target
  (up-next-words.ts), so what follows is clear at a glance; inside a superset round, the partner.
  - Between exercises (the current one has no planned set left) it is the screen's next step: a
    raised card whose Start makes Up next current, its first set ready in the logger. Only Start
    is added, under what was there, so logging the last set moves nothing (Navigation puts the
    card last).
  - Once every exercise is done, Finish workout (`onfinish`) takes Start's place.
  - With `onadd`, Add exercise at its foot: any exercise from the library, after the last one
    (`onintent` on its first press, to fetch the picker).
  - Once a set is logged, a polite live region says where the workout went: 'Next: A2 Plank,
    45 s' when the flow moved to the partner, 'Next: Romanian deadlift, 3 × 8 at RPE 7' once the
    exercise is done. Nothing is said on restore or while sets are left.
  The strength view loads it after the first render, with its space reserved.
-->
<script lang="ts">
	import type { WorkoutView } from '#lib/domain/workout/index.ts';
	import { currentExercise } from '#lib/domain/workout/selectors.ts';
	import Button from '../components/Button.svelte';
	import { toDo } from '#lib/domain/workout/flow.ts';
	import { ALL_DONE, announcement, upNextWords } from './up-next-words.ts';

	interface Props {
		view: WorkoutView;
		/** Start: makes the exercise at this position current. */
		onstart: (position: number) => void;
		/** Finish workout, once nothing is left to do. */
		onfinish?: () => void;
		/** Add exercise: opens the picker. */
		onadd?: (event: MouseEvent) => void;
		onintent?: () => void;
	}

	let { view, onstart, onfinish, onadd, onintent }: Props = $props();

	const next = $derived(upNextWords(view));
	const between = $derived.by(() => {
		const current = currentExercise(view);
		return current !== null && toDo(current) === null;
	});

	let said = $state('');
	/** The sets and the exercise last seen: a set more is what speaks. */
	let seen: { sets: number; position: number } | null = null;
	$effect(() => {
		const sets = view.slots.reduce((n, slot) => n + slot.sets.length, 0);
		const position = currentExercise(view)?.position ?? 0;
		if (seen && sets > seen.sets) {
			const line = announcement(view, position !== seen.position);
			if (line) said = line;
		}
		seen = { sets, position };
	});
</script>

<section
	class="up-next"
	aria-labelledby="up-next-title"
	data-testid="up-next"
	data-between={between ? '' : undefined}
>
	<h3 id="up-next-title" class="eyebrow">Up next</h3>
	<p class="name">
		{#if next}
			{#if next.label}<span class="badge">{next.label}</span>{/if}
			<span>{next.name}</span>
		{:else}
			{between ? ALL_DONE : 'Last exercise'}
		{/if}
	</p>
	<!-- Its line kept with or without a target, so the card's height holds as sets are logged. -->
	<p class="target">{next?.target}</p>
	{#if next && between}
		<div class="start">
			<Button block iconEnd="arrow-right" onclick={() => onstart(next.position)}>
				Start {next.name}
			</Button>
		</div>
	{:else if between && onfinish}
		<div class="start">
			<Button block icon="check" onclick={onfinish} data-testid="up-next-finish">
				Finish workout
			</Button>
		</div>
	{/if}
	{#if onadd}
		<div class="add">
			<Button
				variant="ghost"
				size="sm"
				icon="plus"
				onpointerdown={onintent}
				onclick={onadd}
				data-testid="add-exercise">Add exercise</Button
			>
		</div>
	{/if}
</section>
<p class="visually-hidden" role="status" data-testid="up-next-said">{said}</p>

<style>
	.up-next {
		display: grid;
		gap: var(--space-1);
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-hairline);
	}

	/* Raised by colour only: what logging the last set shows above Start keeps its place. */
	.up-next[data-between] {
		border-color: var(--color-border);
		background: var(--color-surface-2);
	}

	.eyebrow {
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
		color: var(--color-text-tertiary);
	}

	.name {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.badge {
		display: inline-grid;
		place-items: center;
		min-width: 2rem;
		padding: var(--space-0-5) var(--space-1-5);
		border-radius: var(--radius-full);
		background: color-mix(in srgb, var(--color-strength) 16%, transparent);
		font-size: var(--text-xs);
	}

	.target {
		min-height: 1lh;
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
	}

	.start {
		margin-top: var(--space-2);
	}

	.add {
		justify-self: start;
		margin-top: var(--space-1);
	}
</style>
