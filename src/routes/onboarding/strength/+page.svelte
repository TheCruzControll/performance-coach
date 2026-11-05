<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { warmValidation } from '#lib/client/profile-form.ts';
	import { SectionForm } from '#lib/client/section-form.svelte.ts';
	import { baselinesDraft, baselinesPayload, suggestedLifts } from '#lib/ui/profile/forms.ts';
	import BaselinesEditor from '#lib/ui/profile/BaselinesEditor.svelte';
	import { saveAndGoBack } from '../back';
	import Step from '../Step.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const form = new SectionForm(
		untrack(() => baselinesDraft(data.baselines)),
		'baselines',
		baselinesPayload
	);

	onMount(warmValidation);
</script>

<svelte:head>
	<title>Strength baselines · Set up · Performance Coach</title>
</svelte:head>

<Step
	step="strength"
	title="Strength baselines"
	lede="Known maxes help from day one. Don’t know them? That’s what week one is for."
	busy={form.busy}
	error={form.failed}
	oncontinue={() => form.submit()}
	onskip={() => form.submit('?/skip', undefined, { validate: false })}
	onback={(href) => saveAndGoBack(form, href)}
>
	<BaselinesEditor
		bind:value={form.value}
		errors={form.errors}
		unit={data.context.weightUnit}
		suggested={suggestedLifts(data.context.disciplines)}
	/>
</Step>
