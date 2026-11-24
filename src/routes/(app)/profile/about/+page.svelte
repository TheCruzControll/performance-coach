<!--
  Profile → About this app (Paper, 9 · Profile, "About this app"): Backups, Your data, Speed on
  your devices, the version and the design system, under a 40/44 title with no lede. From 1024 px
  Profile's list sits beside it with About open (the same column Profile itself opens), and Back
  is hidden.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { preferences } from '#lib/client/preferences.svelte.ts';
	import Icon from '#lib/ui/components/Icon.svelte';
	import AboutList from '#lib/ui/profile/AboutList.svelte';
	import { aboutAnswer, type ProfileAnswers } from '#lib/ui/profile/answers.ts';
	import { themeLabel } from '#lib/ui/profile/appearance.ts';
	import ProfileList from '#lib/ui/profile/ProfileList.svelte';
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

	// About's own row, as on Profile: its answer once both of its checks have answered.
	let about = $state<ReturnType<typeof aboutAnswer> | null>(null);
	$effect(() => {
		const sent = data.health;
		void Promise.all([sent, data.backups]).then(([health, backups]) => {
			if (data.health === sent)
				about = aboutAnswer(health.db, backups.tone === 'warning' ? 'warning' : undefined);
		});
	});
</script>

<svelte:head>
	<title>About this app · Performance Coach</title>
</svelte:head>

<!-- Split from 1024 px, as a section is: Profile's whole list beside this screen, behind a
     hairline (layout.css). Below that the list is hidden, and Profile is one step back. -->
<div class="split" data-layout="split" data-measure="profile">
	<nav class="sections" aria-label="Profile">
		<ProfileList
			{answers}
			theme={mounted ? themeLabel(preferences.theme) : undefined}
			about={about?.value}
			aboutTone={about?.tone}
			current="about"
		/>
	</nav>

	<div class="column">
		<a class="back-link" href={resolve('/(app)/profile')} data-testid="back-to-profile">
			<Icon name="chevron-left" size={16} /> Profile
		</a>
		<h1 class="title">About this app</h1>

		<div class="rows">
			<AboutList
				backups={data.backups}
				health={data.health}
				vitals={data.vitals}
				version={data.version}
			/>
		</div>
	</div>
</div>

<style>
	/* A section's title (SectionScreen): Hubot 40/44, 40 px under the back link. */
	.title {
		padding-top: var(--space-10);
		font: var(--type-title);
		letter-spacing: var(--tracking-display);
	}

	/* Rows 20 px under the title, as a section's. */
	.rows {
		padding-top: var(--space-5);
	}

	.sections {
		display: none;
	}

	@media (width >= 64rem) {
		.sections {
			display: block;
			/* Level with the open screen's top (Paper, 14: the detail column pads 48 px). */
			padding-top: var(--space-12);
		}

		/* The list says where you are, and the rail is the way out. */
		.back-link {
			display: none;
		}

		/* 32/38 at a desk, as a section's title. */
		.title {
			font: var(--type-statement);
			letter-spacing: var(--tracking-statement);
		}
	}
</style>
