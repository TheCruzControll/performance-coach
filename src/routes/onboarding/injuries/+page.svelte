<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { warmValidation } from '#lib/client/profile-form.ts';
	import { SectionForm } from '#lib/client/section-form.svelte.ts';
	import { injuryDraft } from '#lib/ui/profile/forms.ts';
	import InjuriesEditor from '#lib/ui/profile/InjuriesEditor.svelte';
	import { saveAndGoBack } from '../back';
	import Step from '../Step.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const form = new SectionForm(
		untrack(() => ({ injuries: data.injuries.map(injuryDraft) })),
		'injuries'
	);

	onMount(warmValidation);
</script>

<svelte:head>
	<title>Injuries & limits · Set up · Performance Coach</title>
</svelte:head>

<Step
	step="injuries"
	title="Injuries & limits"
	lede="Anything that hurts, or movements to stay away from. Your coach programs around them — never through pain."
	busy={form.busy}
	error={form.failed}
	oncontinue={() => form.submit()}
	onskip={() => form.submit('?/skip', undefined, { validate: false })}
	onback={(href) => saveAndGoBack(form, href)}
>
	<InjuriesEditor bind:value={form.value} errors={form.errors} />
</Step>
