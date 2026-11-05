<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { warmValidation } from '#lib/client/profile-form.ts';
	import { SectionForm } from '#lib/client/section-form.svelte.ts';
	import { exercisesDraft, exercisesPayload } from '#lib/ui/profile/forms.ts';
	import ExercisesEditor from '#lib/ui/profile/ExercisesEditor.svelte';
	import { saveAndGoBack } from '../back';
	import Step from '../Step.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const form = new SectionForm(
		untrack(() => exercisesDraft(data.exercises)),
		'exercises',
		exercisesPayload
	);

	onMount(warmValidation);
</script>

<svelte:head>
	<title>Exercise preferences · Set up · Performance Coach</title>
</svelte:head>

<Step
	step="exercises"
	title="What you like"
	lede="Training you enjoy is training you do. Tell your coach your favourites and the ones to swap out."
	busy={form.busy}
	error={form.failed}
	oncontinue={() => form.submit()}
	onskip={() => form.submit('?/skip', undefined, { validate: false })}
	onback={(href) => saveAndGoBack(form, href)}
>
	<ExercisesEditor bind:value={form.value} errors={form.errors} />
</Step>
