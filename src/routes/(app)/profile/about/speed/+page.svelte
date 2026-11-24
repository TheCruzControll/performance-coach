<!--
  Profile → About this app → Speed (Paper, 9 · Profile, "Speed"): how the app felt over the last
  7 days, as three plain questions from the p75 web vitals (./speed.ts in src/lib/ui/profile), and
  how many launches they come from. TTFB and FCP are still recorded, and not shown. From 1024 px
  Profile's list sits beside it with About open, and Back is hidden.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { preferences } from '#lib/client/preferences.svelte.ts';
	import Icon from '#lib/ui/components/Icon.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';
	import type { ProfileAnswers } from '#lib/ui/profile/answers.ts';
	import { themeLabel } from '#lib/ui/profile/appearance.ts';
	import ProfileList from '#lib/ui/profile/ProfileList.svelte';
	import { speedNote, speedRows } from '#lib/ui/profile/speed.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Appearance's answer is this device's theme: known once the page has mounted, never on the
	// server, which would say "Dark" to a light device.
	let mounted = $state(false);
	onMount(() => {
		preferences.load();
		mounted = true;
	});

	// The rows' answers stream from the Profile layout's load, as on Profile. About's row has
	// none here: its checks are Profile's and About's (docs/decisions.md, v2/22f).
	let answers = $state<ProfileAnswers | null>(null);
	$effect(() => {
		const sent = data.answers;
		void sent.then((a) => {
			if (data.answers === sent) answers = a;
		});
	});

	/** The three questions' titles, drawn at once; their answers fill in. */
	const QUESTIONS = speedRows(null);
</script>

<svelte:head>
	<title>Speed · Performance Coach</title>
</svelte:head>

<!-- Split from 1024 px, as About is: Profile's whole list beside this screen, About open. -->
<div class="split" data-layout="split" data-measure="profile">
	<nav class="sections" aria-label="Profile">
		<ProfileList
			{answers}
			theme={mounted ? themeLabel(preferences.theme) : undefined}
			current="about"
		/>
	</nav>

	<div class="column">
		<a class="back-link" href={resolve('/(app)/profile/about')} data-testid="back-to-about">
			<Icon name="chevron-left" size={16} /> About
		</a>
		<h1 class="title">Speed</h1>
		<p class="lede">How the app felt on your devices over the last 7 days.</p>

		<!-- Streamed: each row keeps its 60 px while the numbers load, so nothing below moves. -->
		{#await data.vitals}
			<div class="rows" aria-busy="true">
				{#each QUESTIONS as row (row.key)}
					<ListRow title={row.title} static aria-busy data-testid="speed-{row.key}">
						{#snippet trailing()}<Skeleton width="6rem" height="0.875rem" /><span
								class="visually-hidden">Checking…</span
							>{/snippet}
					</ListRow>
				{/each}
			</div>
		{:then vitals}
			<div class="rows">
				{#each speedRows(vitals) as row (row.key)}
					<ListRow title={row.title} static value={row.value} data-testid="speed-{row.key}" />
				{/each}
			</div>
			<p class="note" data-testid="speed-note">{speedNote(vitals)}</p>
		{/await}
	</div>
</div>

<style>
	/* A section's title (SectionScreen): Hubot 40/44, 40 px under the back link. */
	.title {
		padding-top: var(--space-10);
		font: var(--type-title);
		letter-spacing: var(--tracking-display);
	}

	/* Its lede, 8 px under the title. */
	.lede {
		margin-top: var(--space-2);
		font: var(--type-body);
		color: var(--color-text-secondary);
	}

	/* Rows 28 px under a lede, as a section's. */
	.rows {
		display: grid;
		padding-top: var(--space-7);
	}

	/* How many launches: 16 px under the rows. */
	.note {
		margin-top: var(--space-4);
		font: var(--type-caption);
		color: var(--color-text-tertiary);
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
