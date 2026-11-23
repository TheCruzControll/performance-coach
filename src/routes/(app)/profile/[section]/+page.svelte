<script lang="ts">
	import { onMount } from 'svelte';
	import { preferences } from '#lib/client/preferences.svelte.ts';
	import type { ProfileAnswers } from '#lib/ui/profile/answers.ts';
	import { themeLabel } from '#lib/ui/profile/appearance.ts';
	import ProfileList from '#lib/ui/profile/ProfileList.svelte';
	import SectionScreen from './SectionScreen.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Appearance's answer is this device's theme: known once the page has mounted, never on the
	// server, which would say "Dark" to a light device.
	let mounted = $state(false);
	onMount(() => {
		preferences.load();
		mounted = true;
	});

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

<!-- Split from 1024 px, at Profile's measure (layout.css): Profile's whole list beside the open
     section's editor, behind a hairline (docs/design-system.md, Responsive layout → Screens).
     Below that the list is hidden: a phone goes list → editor → back. The list stays mounted from
     section to section. -->
<div class="split" data-layout="split" data-measure="profile">
	<nav class="sections" aria-label="Profile">
		<ProfileList
			{answers}
			theme={mounted ? themeLabel(preferences.theme) : undefined}
			current={data.key}
		/>
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
			/* Level with the open screen's top (Paper, 14: the detail column pads 48 px). */
			padding-top: var(--space-12);
		}
	}
</style>
