<script lang="ts">
	import SectionList from '#lib/ui/profile/SectionList.svelte';
	import SectionScreen from './SectionScreen.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{data.title} · Performance Coach</title>
</svelte:head>

<!-- Split from 1024 px: the sections beside the open one's editor, which stays the readable
     column (docs/design-system.md, Responsive layout → Content width). Below that the list is
     hidden: a phone goes list → editor → back. The list stays mounted from section to section. -->
<div class="split" data-layout="split">
	<nav class="sections" aria-labelledby="section-list-label">
		<p id="section-list-label" class="label">Training profile</p>
		<SectionList current={data.key} />
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
			display: grid;
			gap: var(--space-2);
			/* Level with the editor's title: the header's top padding. */
			padding-top: var(--space-6);
		}

		/* The list and the readable editor, centred together in the wide column. */
		.split {
			justify-content: center;
		}
	}

	.label {
		margin-bottom: var(--space-1);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--color-text-secondary);
	}
</style>
