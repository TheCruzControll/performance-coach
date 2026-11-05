<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { warmValidation } from '#lib/client/profile-form.ts';
	import { SectionForm } from '#lib/client/section-form.svelte.ts';
	import { scheduleDraft } from '#lib/ui/profile/forms.ts';
	import ScheduleEditor from '#lib/ui/profile/ScheduleEditor.svelte';
	import { saveAndGoBack } from '../back';
	import Step from '../Step.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const form = new SectionForm(
		untrack(() => scheduleDraft(data.schedule)),
		'schedule'
	);

	onMount(warmValidation);
</script>

<svelte:head>
	<title>Schedule · Set up · Performance Coach</title>
</svelte:head>

<Step
	step="schedule"
	title="Your week"
	lede="A plan only works if it fits. Your coach builds around these days and commitments."
	busy={form.busy}
	error={form.failed}
	oncontinue={() => form.submit()}
	onback={(href) => saveAndGoBack(form, href)}
>
	<ScheduleEditor
		bind:value={form.value}
		errors={form.errors}
		disciplines={data.context.disciplines}
	/>
</Step>
