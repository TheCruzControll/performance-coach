<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { warmValidation } from '#lib/client/profile-form.ts';
	import { SectionForm } from '#lib/client/section-form.svelte.ts';
	import { specificsDraft, specificsPayload } from '#lib/ui/profile/forms.ts';
	import SpecificsEditor from '#lib/ui/profile/SpecificsEditor.svelte';
	import { saveAndGoBack } from '../back';
	import Step from '../Step.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const form = new SectionForm(
		untrack(() =>
			specificsDraft(data.specifics, data.context.disciplines, data.context.distanceUnit)
		),
		'specifics',
		specificsPayload
	);

	onMount(warmValidation);
</script>

<svelte:head>
	<title>Running & Muay Thai · Set up · Performance Coach</title>
</svelte:head>

<Step
	step="specifics"
	title="Running & Muay Thai"
	lede="Where your engine and your skill work are right now. Leave out what you don’t know."
	busy={form.busy}
	error={form.failed}
	oncontinue={() => form.submit()}
	onskip={() => form.submit('?/skip', undefined, { validate: false })}
	onback={(href) => saveAndGoBack(form, href)}
>
	<SpecificsEditor bind:value={form.value} errors={form.errors} />
</Step>
