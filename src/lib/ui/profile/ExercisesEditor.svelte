<!--
  @component
  Exercises the owner enjoys and the ones they'd rather not do. The coach favours the first
  and substitutes the second (a dislike is a preference, not an injury).
-->
<script lang="ts">
	import { EXERCISE_SUGGESTIONS } from '#lib/domain/profile/catalog.ts';
	import type { FieldErrors } from '#lib/domain/profile/schemas.ts';
	import Notice from '../components/Notice.svelte';
	import TagInput from '../components/TagInput.svelte';

	interface Props {
		value: { likes: string[]; dislikes: string[] };
		errors?: FieldErrors;
	}

	let { value = $bindable(), errors = {} }: Props = $props();

	const taken = $derived(new Set([...value.likes, ...value.dislikes].map((e) => e.toLowerCase())));
	const free = $derived(EXERCISE_SUGGESTIONS.filter((e) => !taken.has(e.toLowerCase())));
	const itemError = $derived(Object.entries(errors).find(([k]) => k.startsWith('items.'))?.[1]);
</script>

<div class="exercises">
	<section class="block" data-tone="like">
		<TagInput
			label="Exercises you enjoy"
			bind:value={value.likes}
			suggestions={free.slice(0, 6)}
			placeholder="e.g. Front squat"
			hint="Your coach leans on these when there’s a choice."
			data-testid="likes"
		/>
	</section>
	<section class="block" data-tone="dislike">
		<TagInput
			label="Exercises you’d rather avoid"
			bind:value={value.dislikes}
			suggestions={free.slice(6, 12)}
			placeholder="e.g. Burpees"
			hint="Swapped for an equivalent — injuries go in the previous step."
			data-testid="dislikes"
		/>
	</section>
	{#if errors.items || itemError}<Notice tone="danger">{errors.items ?? itemError}</Notice>{/if}
</div>

<style>
	.exercises {
		display: grid;
		gap: var(--space-4);
	}

	.block {
		padding: var(--space-4);
		border-radius: var(--radius-xl);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
		box-shadow: var(--elevation-1);
	}
</style>
