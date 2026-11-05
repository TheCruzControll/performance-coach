<script lang="ts">
	import { SectionForm } from '#lib/client/section-form.svelte.ts';
	import type { OnboardingStep } from '#lib/domain/profile/onboarding.ts';
	import { resolve } from '$app/paths';
	import ProfileSummary from './ProfileSummary.svelte';
	import Step from '../Step.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const form = new SectionForm({});
	const editHref = (step: OnboardingStep) =>
		step === 'welcome' ? resolve('/onboarding') : `${resolve('/onboarding')}/${step}`;
</script>

<svelte:head>
	<title>Review · Set up · Performance Coach</title>
</svelte:head>

<Step
	step="review"
	title="Here’s your training profile"
	lede="Check it over — you can change any of it later in Profile. Your coach plans week one from this."
	busy={form.busy}
	error={form.failed}
	continueLabel="Start coaching"
	oncontinue={() => form.submit('?/complete', undefined, { validate: false })}
>
	<ProfileSummary
		profile={data.profile}
		steps={data.onboarding.steps}
		errors={form.errors}
		href={editHref}
	/>
</Step>
