<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { warmValidation } from '#lib/client/profile-form.ts';
	import { SectionForm } from '#lib/client/section-form.svelte.ts';
	import GoalsEditor from '#lib/ui/profile/GoalsEditor.svelte';
	import Step from '../Step.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Goals save as they change (the sheet); Continue only checks there is one and moves on.
	let goals = $state(untrack(() => data.goals));
	const form = new SectionForm({});

	onMount(warmValidation);
</script>

<svelte:head>
	<title>Goals · Set up · Performance Coach</title>
</svelte:head>

<Step
	step="goals"
	title="What are you training for?"
	lede="One goal or several. Rank them — your coach plans around the top one when they compete."
	busy={form.busy}
	error={form.errors.goals ? null : form.failed}
	oncontinue={() => form.submit('?/save', undefined, { validate: false })}
>
	<GoalsEditor bind:goals error={form.errors.goals} />
</Step>
