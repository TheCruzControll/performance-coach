<!--
  @component
  Fix for a refused swap (fix/structure.ts), in a BottomSheet (a centred dialog from 1024 px): the
  slot's alternatives again, ranked for the swap's reason, under why the server refused it.
  Choosing one hands back the swap to it, under the same id; the sync sheet checks it and
  re-queues it in its place. Discard is the sync sheet's.
-->
<script lang="ts">
	import { ALTERNATIVES_COPY } from '#lib/domain/workout/copy.ts';
	import type { Mutation } from '#lib/domain/workout/index.ts';
	import { slotAt } from '#lib/domain/workout/selectors.ts';
	import { rankFor } from '#lib/domain/workout/substitution.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import AlternativeList from '../AlternativeList.svelte';
	import type { FixEditorProps } from './registry.ts';

	let { open = $bindable(), m, problem, view, onsave }: FixEditorProps = $props();

	const swap = $derived(m.type === 'exercise.substitute' ? m : null);
	const alternatives = $derived.by(() => {
		const slot = swap && view && slotAt(view, swap.payload.position);
		if (!swap || !slot) return [];
		const from = { ...slot, exerciseId: swap.payload.fromExerciseId };
		return rankFor(swap.payload.reason, slot.kit?.alternatives ?? [], from).filter(
			(a) => a.exercise.id !== from.exerciseId
		);
	});

	function choose(toExerciseId: string) {
		if (!swap) return;
		onsave({ ...swap, payload: { ...swap.payload, toExerciseId } } satisfies Mutation);
		open = false;
	}
</script>

<BottomSheet
	bind:open
	title={ALTERNATIVES_COPY.suggest_alternative.title}
	description="Pick another exercise for this slot."
	data-testid="substitute-fix"
>
	<AlternativeList
		{alternatives}
		blocked={[]}
		error={problem}
		onchoose={(alternative) => choose(alternative.exercise.id)}
	/>
</BottomSheet>
