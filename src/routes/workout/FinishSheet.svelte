<!--
  @component
  Finish (loaded on demand: from the menu, or after the last exercise), in a BottomSheet: a
  centred dialog from 1024 px, Escape closes it and focus returns.
  - With planned sets still open it asks first ('2 planned sets are still open'): Keep going, or
    Finish anyway.
  - Then the summary (Summary.svelte) with its fields: the duration, the session RPE and the notes.
    Done sends a workout.finish carrying them through the page's `store` (finish.ts); online, if
    the server has it within about 300 ms, it opens the workout's History detail. Otherwise the
    page shows its completed state at once, with 'View in History' when the sync confirms.
  - Fix (fix/workout.ts) opens it on a refused workout.update or workout.finish, `m`: no question,
    the refused values and the server's errors in place, and Save hands back the change with the
    corrected values under the same id, for the sync sheet to re-queue in its place.
  Its props are the Fix registry's (FixEditorProps), with `store` instead of `onsave` for Done.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { WorkoutStore } from '#lib/client/workout/store.ts';
	import type { FieldErrors } from '#lib/domain/validation.ts';
	import type { Mutation, WorkoutFields, WorkoutView } from '#lib/domain/workout/index.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import { untrack } from 'svelte';
	import { finishMutation, finishWorkout, noteOf, openSets, valuesOf } from './finish.ts';
	import Summary from './Summary.svelte';

	interface Props {
		open: boolean;
		/** The refused change being fixed; none for Done. */
		m?: Mutation;
		/** Why the server refused it, in words. */
		problem?: string;
		errors?: FieldErrors;
		view: WorkoutView | null;
		/** Fix: the corrected change, for the sync sheet to re-queue. */
		onsave?: (next: Mutation) => void;
		/** Done: the page's store, which the finish goes through. */
		store?: WorkoutStore | null;
	}

	let { open = $bindable(), m, problem, errors, view, onsave, store }: Props = $props();

	// Each time it opens: the open sets asked about, and the fields' first values.
	let left = $state(0);
	let asking = $state(false);
	let values = $state.raw<WorkoutFields>({ durationSeconds: null, sessionRpe: null, notes: null });
	$effect.pre(() => {
		if (!open) return;
		untrack(() => {
			left = m || !view ? 0 : openSets(view);
			asking = left > 0;
			values = valuesOf(m, view, Date.now());
		});
	});
	const sets = $derived(`${left} planned ${left === 1 ? 'set is' : 'sets are'} still open`);

	async function save() {
		const fields = { ...values, notes: noteOf(values.notes) };
		open = false;
		if (m) return onsave?.({ ...m, payload: { ...m.payload, ...fields } } as Mutation);
		if (!view || !store) return;
		const { id } = view.workout;
		if ((await finishWorkout(store, finishMutation(id, fields, Date.now()))) === 'history') {
			await goto(resolve('/(app)/progress/workouts/[[id]]', { id }));
		}
	}
</script>

<BottomSheet
	bind:open
	title={asking ? 'Finish workout?' : m ? 'Fix the summary' : 'Workout summary'}
	description={asking ? sets : view?.workout.title}
	data-testid="finish-sheet"
>
	{#if asking}
		<p class="consequence" data-testid="finish-ask">
			Finishing now leaves {left === 1 ? 'it' : 'them'} not done, in the summary and in History.
		</p>
	{:else}
		{#if problem}<p class="fix" data-testid="fix-reason">Not synced · {problem}</p>{/if}
		{#if view}
			<Summary
				{view}
				editing={{ values, errors, onchange: (change) => (values = { ...values, ...change }) }}
			/>
		{/if}
	{/if}
	{#snippet footer()}
		{#if asking}
			<div class="actions">
				<Button block variant="secondary" onclick={() => (open = false)} data-testid="keep-going"
					>Keep going</Button
				>
				<Button block icon="check" onclick={() => (asking = false)} data-testid="finish-anyway"
					>Finish anyway</Button
				>
			</div>
		{:else}
			<Button block icon="check" onclick={save} data-testid={m ? 'save-fix' : 'finish-done'}
				>{m ? 'Save' : 'Done'}</Button
			>
		{/if}
	{/snippet}
</BottomSheet>

<style>
	.consequence {
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		color: var(--color-text-secondary);
	}

	.actions {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-2);
	}

	.fix {
		margin-bottom: var(--space-4);
		color: light-dark(color-mix(in srgb, var(--color-warning) 82%, #000), var(--color-warning));
		font-weight: var(--weight-medium);
	}
</style>
