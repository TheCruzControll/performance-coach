<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { warmValidation } from '#lib/client/profile-form.ts';
	import { SectionForm } from '#lib/client/section-form.svelte.ts';
	import { bodyDraft, bodyPayload } from '#lib/ui/profile/forms.ts';
	import BodyEditor from '#lib/ui/profile/BodyEditor.svelte';
	import { saveAndGoBack } from '../back';
	import Step from '../Step.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const form = new SectionForm(
		untrack(() => bodyDraft(data.body.profile, data.body.bodyWeight)),
		'body',
		bodyPayload
	);

	onMount(warmValidation);
</script>

<svelte:head>
	<title>Body & nutrition · Set up · Performance Coach</title>
</svelte:head>

<Step
	step="body"
	title="Body & nutrition"
	lede="It informs training — it never overrides performance or recovery."
	busy={form.busy}
	error={form.failed}
	oncontinue={() => form.submit()}
	onskip={() => form.submit('?/skip', undefined, { validate: false })}
	onback={(href) => saveAndGoBack(form, href)}
>
	<BodyEditor bind:value={form.value} errors={form.errors} />
</Step>
