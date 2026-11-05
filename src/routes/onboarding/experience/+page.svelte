<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { warmValidation } from '#lib/client/profile-form.ts';
	import { SectionForm } from '#lib/client/section-form.svelte.ts';
	import { experienceDraft } from '#lib/ui/profile/forms.ts';
	import ExperienceEditor from '#lib/ui/profile/ExperienceEditor.svelte';
	import { saveAndGoBack } from '../back';
	import Step from '../Step.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const form = new SectionForm(
		untrack(() => experienceDraft(data.experience, data.context.disciplines)),
		'experience'
	);

	onMount(warmValidation);
</script>

<svelte:head>
	<title>Experience · Set up · Performance Coach</title>
</svelte:head>

<Step
	step="experience"
	title="How experienced are you?"
	lede="For each discipline you train. Rough is fine — it sets how hard week one starts."
	busy={form.busy}
	error={form.failed}
	oncontinue={() => form.submit()}
	onback={(href) => saveAndGoBack(form, href)}
>
	<ExperienceEditor bind:value={form.value} errors={form.errors} />
</Step>
