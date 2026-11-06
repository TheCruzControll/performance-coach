<!--
  @component
  Profile → Exercises: the ones the owner enjoys, which the coach picks when there is a choice,
  and the ones they’d rather swap out, which it replaces with one that does the same job. A
  dislike is a preference, not an injury: pain goes under Injuries.
-->
<script lang="ts">
	import { EXERCISE_SUGGESTIONS } from '#lib/domain/profile/catalog.ts';
	import Surface from '../components/Surface.svelte';
	import TagInput from '../components/TagInput.svelte';
	import type { EditorProps } from './editors';
	import { listErrors, type ExercisesDraft } from './exercises';

	let { value = $bindable(), errors = {} }: EditorProps<ExercisesDraft> = $props();

	// The schema takes up to 60 exercises in all: 30 a list keeps any mix within that.
	const MAX = 30;
	// Four suggestions a list: enough to start from, without pushing the second list off screen.
	const SUGGESTED = 4;

	// A suggestion leaves both lists once either has it. Likes are offered from the top of the
	// catalogue (the main lifts), dislikes from the bottom (conditioning).
	const taken = $derived(new Set([...value.likes, ...value.dislikes].map((e) => e.toLowerCase())));
	const free = $derived(EXERCISE_SUGGESTIONS.filter((e) => !taken.has(e.toLowerCase())));
	const shown = $derived(listErrors(errors, value.likes.length));
</script>

<div class="exercises">
	<Surface padding="md" radius="xl">
		<TagInput
			label="Exercises you enjoy"
			bind:value={value.likes}
			error={shown.likes}
			suggestions={free.slice(0, SUGGESTED)}
			placeholder="e.g. Front squat"
			hint="Your coach leans on these when there’s a choice."
			max={MAX}
			data-testid="likes"
		/>
	</Surface>
	<Surface padding="md" radius="xl">
		<TagInput
			label="Exercises you’d rather swap out"
			bind:value={value.dislikes}
			error={shown.dislikes}
			suggestions={free.slice(-SUGGESTED).reverse()}
			placeholder="e.g. Burpees"
			hint="Swapped for one that does the same job. Pain or an injury goes under Injuries."
			max={MAX}
			data-testid="dislikes"
		/>
	</Surface>
</div>

<style>
	.exercises {
		display: grid;
		gap: var(--space-4);
	}
</style>
