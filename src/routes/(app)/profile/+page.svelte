<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { preferences } from '#lib/client/preferences.svelte.ts';
	import Icon from '#lib/ui/components/Icon.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import AboutList from '#lib/ui/profile/AboutList.svelte';
	import { aboutAnswer, type ProfileAnswers } from '#lib/ui/profile/answers.ts';
	import { themeLabel } from '#lib/ui/profile/appearance.ts';
	import ProfileList from '#lib/ui/profile/ProfileList.svelte';
	import { stepHref } from '../../onboarding/paths';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Appearance's answer is this device's theme: known once the page has mounted, never on the
	// server, which would say "Dark" to a light device.
	let mounted = $state(false);
	onMount(() => {
		preferences.load();
		mounted = true;
	});

	// The rows' answers stream from the Profile layout's load: the rows stay mounted, showing their
	// titles, and their values fill in. A newer load (after a save) replaces an older one's.
	let answers = $state<ProfileAnswers | null>(null);
	$effect(() => {
		const sent = data.answers;
		void sent.then((a) => {
			if (data.answers === sent) answers = a;
		});
	});

	// About this app's answer ("All working", or what needs a look), once both of its checks have
	// answered: the row shows its title until then. A newer load's replaces an older one's.
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
	<title>Profile · Performance Coach</title>
</svelte:head>

<a class="back-link" href={resolve('/(app)/today')} data-testid="back-to-today">
	<Icon name="chevron-left" size={16} /> Today
</a>
<div class="head">
	<PageHeader title="Profile" />
	<p class="lede" data-testid="owner-name">{data.owner.name}</p>
</div>

<!-- Split from 1024 px, at Profile's measure (layout.css): the list, then About this app behind a
     hairline, where a section's screen has its own content (the owner's default). Below 1024 px
     About is one row away, and its column is not drawn. -->
<div class="profile" data-layout="split" data-measure="profile">
	<div class="list-column">
		<!-- Streamed: nothing until it settles, and nothing if setup is done or the read failed. -->
		{#await data.setup then setup}
			{#if setup}
				<div class="setup">
					<ListRow
						title="Finish setting up"
						value={setup.stoppedAt ? `Stopped at ${setup.stoppedAt}` : undefined}
						href={stepHref(setup.resume)}
						data-testid="continue-setup"
					/>
				</div>
			{/if}
		{/await}
		<!-- No row is current: the open side is About only from 1024 px, and aria-current cannot
		     differ between widths. -->
		<ProfileList
			{answers}
			theme={mounted ? themeLabel(preferences.theme) : undefined}
			about={about?.value}
			aboutTone={about?.tone}
		/>
	</div>

	<section class="about" aria-labelledby="about-app">
		<h2 class="visually-hidden" id="about-app">About this app</h2>
		<AboutList
			backups={data.backups}
			health={data.health}
			vitals={data.vitals}
			version={data.version}
		/>
	</section>
</div>

<style>
	/* Rows only: from 1024 px the columns are Profile's measure's (layout.css). */
	.profile {
		display: grid;
		row-gap: var(--space-9);
	}

	.list-column {
		display: grid;
		gap: var(--space-9);
	}

	/* The owner's name, 8 px under the title (the header pads 20 px below it). */
	.lede {
		margin-top: calc(var(--space-2) - var(--space-5));
		font: var(--type-body);
		color: var(--color-text-secondary);
	}

	/* "Finish setting up" (Paper, 9 · "Finish setting up"): a 600 title, no hairline under it. */
	.setup :global(.title) {
		font-weight: var(--weight-semibold);
	}

	.setup :global(.row) {
		border-bottom-color: transparent;
	}

	/* A phone reaches About through its row. */
	.about {
		display: none;
	}

	/* On a phone the row sits 16 px under the owner's name (the name's line box ends the head). */
	@media (width < 64rem) {
		.setup {
			margin-top: var(--space-4);
		}
	}

	/* From 1024 px the rail is the way back to Today, so the link goes, and the owner's name sits
	   above the title in 15 px (Paper, 14 · "Profile, goals"). About this app is the open side. */
	@media (width >= 64rem) {
		.back-link {
			display: none;
		}

		.head {
			display: flex;
			flex-direction: column;
		}

		.lede {
			order: -1;
			margin-top: 0;
			font: var(--type-secondary);
		}

		.about {
			display: block;
		}
	}
</style>
