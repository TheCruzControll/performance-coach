<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { warmValidation } from '#lib/client/profile-form.ts';
	import { SectionForm } from '#lib/client/section-form.svelte.ts';
	import { equipmentDraft } from '#lib/ui/profile/forms.ts';
	import EquipmentEditor from '#lib/ui/profile/EquipmentEditor.svelte';
	import { saveAndGoBack } from '../back';
	import Step from '../Step.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const form = new SectionForm(
		untrack(() => equipmentDraft(data.equipment)),
		'equipment'
	);

	onMount(warmValidation);
</script>

<svelte:head>
	<title>Equipment · Set up · Performance Coach</title>
</svelte:head>

<Step
	step="equipment"
	title="Where you train"
	lede="So every exercise in your plan is one you can actually do."
	busy={form.busy}
	error={form.failed}
	oncontinue={() => form.submit()}
	onskip={() => form.submit('?/skip', undefined, { validate: false })}
	onback={(href) => saveAndGoBack(form, href)}
>
	<EquipmentEditor bind:value={form.value} errors={form.errors} />
</Step>
