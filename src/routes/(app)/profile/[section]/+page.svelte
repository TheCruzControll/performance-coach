<script lang="ts">
	import type { ProfileAnswers } from '#lib/ui/profile/answers.ts';
	import ProfileList from '#lib/ui/profile/ProfileList.svelte';
	import SectionScreen from './SectionScreen.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// The rows' answers stream from the Profile layout's load, as on Profile: the list stays
	// mounted and its values fill in. A newer load (after a save) replaces an older one's.
	let answers = $state<ProfileAnswers | null>(null);
	$effect(() => {
		const sent = data.answers;
		void sent.then((a) => {
			if (data.answers === sent) answers = a;
		});
	});
</script>

<svelte:head>
	<title>{data.title} · Performance Coach</title>
</svelte:head>

<!-- Split from 1024 px: Profile's whole list beside the open section's editor, which stays the
     readable column (docs/design-system.md, Responsive layout → Content width). Below that the
     list is hidden: a phone goes list → editor → back. The list stays mounted from section to
     section. -->
<div class="split" data-layout="split">
	<nav class="sections" aria-label="Profile">
		<ProfileList {answers} current={data.key} />
	</nav>

	<!-- Another section is another screen, with its own editor and form state: a keyed block of one
     mounts it afresh. ({#key} would do the same, but its helper would join the runtime that
     every route loads.) -->
	{#each [data.key] as key (key)}
		<SectionScreen
			{key}
			title={data.title}
			saved={data.saved}
			context={data.context}
			saveBar={data.saveBar}
		/>
	{/each}
</div>

<style>
	.sections {
		display: none;
	}

	@media (width >= 64rem) {
		.sections {
			display: block;
			/* Level with the editor's title: the header's top padding. */
			padding-top: var(--space-6);
		}

		/* The list and the readable editor, centred together in the wide column. */
		.split {
			justify-content: center;
		}
	}
</style>
