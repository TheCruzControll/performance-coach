<script lang="ts">
	import SectionScreen from './SectionScreen.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{data.title} · Performance Coach</title>
</svelte:head>

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
