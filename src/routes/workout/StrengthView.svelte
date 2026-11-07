<!--
  @component
  The strength workout (PRD §7): the current exercise (the device's position, so a reload returns
  to it) as an ExerciseCard with its set rows, and from 1024 px the session's exercise list beside
  it. Below 1024 px the current exercise has the screen. It renders two siblings, the side list
  and the main column, which the Shell lays out as its columns. Display only: log-set adds the
  logger, exercise-navigation the ways to change the current exercise.
-->
<script lang="ts">
	import { groups } from '#lib/domain/workout/flow.ts';
	import type { WorkoutView } from '#lib/domain/workout/index.ts';
	import { currentExercise, plannedVsLogged, previousFor } from '#lib/domain/workout/selectors.ts';
	import ExerciseCard from '#lib/ui/workout/ExerciseCard.svelte';
	import SetRow from '#lib/ui/workout/SetRow.svelte';
	import {
		doneText,
		lastTimeText,
		loadLine,
		restText,
		setRows
	} from '#lib/ui/workout/set-words.ts';
	import ExerciseList from './ExerciseList.svelte';

	interface Props {
		view: WorkoutView;
	}

	let { view }: Props = $props();

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
		const rows = setRows(
			plannedVsLogged(view, slot.position),
			slot.state === 'skipped' || slot.state === 'stopped'
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
			rows
		};
	});
</script>

<ExerciseList {items} current={current?.position} />

<div data-testid="workout-main">
	{#if current}
		<ExerciseCard exercise={current}>
			{#each current.rows as row, i (i)}
				<SetRow {row} />
			{/each}
		</ExerciseCard>
	{/if}
</div>
