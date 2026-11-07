<!--
  @component
  The strength view's set editor, code-split with SetEditSheet and loaded on a row's first intent,
  so none of it weighs on /workout's initial JavaScript. Each tap opens it; it shows the set as it
  was when its row was tapped (the row may go while the sheet closes), and sends what the sheet hands back through
  the store: Save a set.edit with every value, Delete a set.delete, each under a fresh id
  addressing the set's client id, so an edit made before the set's set.log synced still applies,
  queued after it.
-->
<script lang="ts">
	import type { WorkoutStore } from '#lib/client/workout/store.ts';
	import { DEFAULT_LOAD_INCREMENT } from '#lib/domain/units.ts';
	import type { Mutation, WorkoutView } from '#lib/domain/workout/index.ts';
	import { slotAt } from '#lib/domain/workout/selectors.ts';
	import { createMutation } from '#lib/domain/workout/mutations.ts';
	import type { CanonicalSet } from '#lib/domain/workout/protocol.ts';
	import SetEditSheet from './SetEditSheet.svelte';

	interface Props {
		view: WorkoutView;
		/** The tapped set, a new object per tap: each opens the sheet afresh from its values. */
		editing: { set: CanonicalSet };
		store: WorkoutStore;
	}

	let { view, editing, store }: Props = $props();
	const set = $derived(editing.set);

	let open = $state(false);
	let taps = 0;
	// Each tap: the sheet opens, its draft started again from the set's values.
	const editKey = $derived.by(() => {
		void editing;
		taps += 1;
		return String(taps);
	});
	$effect.pre(() => {
		void editing;
		open = true;
	});

	const exercise = $derived(view.exercises[set.exerciseId]);
	const increment = $derived(
		slotAt(view, set.position)?.kit?.exercise.increment ?? DEFAULT_LOAD_INCREMENT[set.unit]
	);
	const values = $derived.by(() => {
		const { reps, seconds, metres, weight, assistance, unit, rpe, missedReps, isWarmup, isExtra } =
			set;
		return { reps, seconds, metres, weight, assistance, unit, rpe, missedReps, isWarmup, isExtra };
	});

	/** set.edit or set.delete of this set, under a fresh id, addressing its client id. */
	function send(
		mutation: (input: { workoutId: string; entityId: string; at: string }) => Mutation
	) {
		const at = new Date().toISOString();
		store.dispatch(mutation({ workoutId: view.workout.id, entityId: set.id, at }));
	}
</script>

<SetEditSheet
	bind:open
	{editKey}
	setIndex={set.setIndex}
	exercise={{
		name: exercise?.name ?? 'Exercise',
		measure: exercise?.measure ?? 'reps',
		loadType: exercise?.loadType ?? 'external'
	}}
	{values}
	skipped={set.isSkipped}
	{increment}
	onsave={(payload) => send((input) => createMutation('set.edit', { ...input, payload }))}
	ondelete={() => send((input) => createMutation('set.delete', { ...input, payload: {} }))}
/>
