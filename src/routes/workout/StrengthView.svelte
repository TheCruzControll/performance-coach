<!--
  @component
  The strength workout (PRD §7): the current exercise (the device's position, so a reload returns
  to it) as an ExerciseCard with its set rows, and from 1024 px the session's exercise list beside
  it. Below 1024 px the current exercise has the screen. It renders two siblings, the side list
  and the main column, which the Shell lays out as its columns.
  - Under the rows, the logger (Logger.svelte, loaded right after the first render, and shown
    once the store has loaded too, so Complete set never waits for either) logs the set at hand
    in one tap: the row is done in the same frame, before anything is written, and in a superset
    the move to the partner is written with it. It never waits for the network.
  - A set this device could not save reads 'Not saved on this device'; the logger offers Retry.
  exercise-navigation adds the ways to change the current exercise.
-->
<script lang="ts">
	import type {
		ActiveSnapshot,
		ActiveWorkout,
		ChunkLoad
	} from '#lib/client/workout/active.svelte.ts';
	import { groups } from '#lib/domain/workout/flow.ts';
	import { currentExercise, plannedVsLogged, previousFor } from '#lib/domain/workout/selectors.ts';
	import ExerciseCard from '#lib/ui/workout/ExerciseCard.svelte';
	import SetRow from '#lib/ui/workout/SetRow.svelte';
	import {
		doneText,
		lastTimeText,
		loadLine,
		restText,
		SET_STATE_WORDS,
		setRows
	} from '#lib/ui/workout/set-words.ts';
	import { onMount } from 'svelte';
	import ExerciseList from './ExerciseList.svelte';
	import type LoggerView from './Logger.svelte';

	interface Props {
		snapshot: ActiveSnapshot;
		/** The page's chunk loader, for the logger. */
		load: ChunkLoad;
		active: ActiveWorkout;
	}

	let { snapshot, load, active }: Props = $props();
	const view = $derived(snapshot.view);
	/** The rows this device could not save, by client id. */
	const notSaved = $derived(
		new Set(
			snapshot.notSaved.flatMap((n) =>
				n.entities.filter((key) => key.startsWith('set:')).map((key) => key.slice(4))
			)
		)
	);

	const labels = $derived(
		new Map(
			groups({ exercises: view.slots }).flatMap((group) =>
				group.members.map((member) => [member.position, member.label] as const)
			)
		)
	);

	// The projection names every exercise a slot performs, the kit's and the canonical rows'.
	const nameOf = (exerciseId: string) => view.exercises[exerciseId]?.name ?? 'Exercise';

	// Each exercise's planned sets and how many are logged or skipped (extra sets never count).
	const items = $derived(
		view.slots.map((slot) => {
			const total = slot.kit?.sets.length || slot.sets.length;
			return {
				position: slot.position,
				label: labels.get(slot.position),
				name: nameOf(slot.exerciseId),
				done: Math.min(total, slot.sets.filter((set) => !set.isExtra).length),
				total
			};
		})
	);

	const current = $derived.by(() => {
		const slot = currentExercise(view);
		if (!slot) return null;
		const paired = plannedVsLogged(view, slot.position);
		const rows = setRows(paired, slot.state === 'skipped' || slot.state === 'stopped').map(
			(row, i) =>
				notSaved.has(paired[i]!.logged?.id ?? '')
					? { ...row, state: 'not-saved' as const, word: SET_STATE_WORDS['not-saved'] }
					: row
		);
		const sets = slot.kit?.sets ?? [];
		// The set at hand: the current row's, else (all done) the first.
		const at = sets[(rows.find((row) => row.state === 'current')?.setIndex ?? 1) - 1];
		const previous = previousFor(view, slot.position);
		return {
			position: slot.position,
			name: nameOf(slot.exerciseId),
			label: labels.get(slot.position),
			place: `Exercise ${view.slots.indexOf(slot) + 1} of ${view.slots.length}`,
			lines: [...new Set(sets.map((set) => set.line))],
			load: loadLine(at, view.exercises[slot.exerciseId]?.loadType),
			rest: restText(at?.restSeconds),
			previous: previous && {
				heading: lastTimeText(previous.date, view.kit?.date),
				sets: previous.sets.map(doneText)
			},
			slot,
			open: rows.some((row) => row.state === 'current'),
			rows
		};
	});

	// The logger and its prefill rules load after the first render (Logger.svelte says why); it
	// shows once the store (the Shell's, on idle) can write too.
	let Logger = $state.raw<typeof LoggerView | null>(null);
	onMount(() => {
		if (import.meta.env.SSR) return;
		void load(() => import('./Logger.svelte')).then((module) => {
			if (module) Logger = module.default;
		});
	});
</script>

<ExerciseList {items} current={current?.position} />

<div class="main" data-testid="workout-main">
	{#if current}
		<ExerciseCard exercise={current}>
			{#each current.rows as row, i (i)}
				<SetRow {row} />
			{/each}
		</ExerciseCard>
	{/if}
	{#if current && Logger && active.store}
		<Logger
			{view}
			slot={current.slot}
			open={current.open}
			notSaved={snapshot.notSaved}
			store={active.store}
		/>
	{/if}
</div>

<style>
	.main {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: var(--space-4);
		min-width: 0;
	}
</style>
