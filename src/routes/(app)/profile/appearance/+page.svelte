<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { preferences } from '#lib/client/preferences.svelte.ts';
	import { setTheme } from '#lib/client/theme.ts';
	import ChoiceGroup from '#lib/ui/components/ChoiceGroup.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import type { ProfileAnswers } from '#lib/ui/profile/answers.ts';
	import { THEMES, themeLabel } from '#lib/ui/profile/appearance.ts';
	import ProfileList from '#lib/ui/profile/ProfileList.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// This device's choices, read from its storage once the page has mounted: the server cannot
	// know them, so the list's Appearance row says nothing until then.
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
	<title>Appearance · Performance Coach</title>
</svelte:head>

<!-- Split from 1024 px, as a section is: Profile's whole list beside this screen. Below that the
     list is hidden, and Profile is one step back. A theme applies the moment it is picked
     (setTheme), so there is no Save and no "Saved". -->
<div class="split" data-layout="split" data-measure="profile">
	<nav class="sections" aria-label="Profile">
		<ProfileList
			{answers}
			theme={mounted ? themeLabel(preferences.theme) : undefined}
			current="appearance"
		/>
	</nav>

	<div class="column">
		<a class="back-link" href={resolve('/(app)/profile')} data-testid="back-to-profile">
			<Icon name="chevron-left" size={16} /> Profile
		</a>
		<PageHeader title="Appearance" />

		<div class="choices">
			<ChoiceGroup
				legend="Theme"
				hideLegend
				variant="card"
				options={THEMES}
				bind:value={() => preferences.theme, (t) => t && setTheme(t)}
				data-testid="theme-control"
			/>
			<ChoiceGroup
				legend="Weights on this device"
				variant="card"
				options={[
					{ value: 'kg', label: 'Kilograms' },
					{ value: 'lb', label: 'Pounds' }
				]}
				bind:value={() => preferences.units, (u) => u && preferences.setUnits(u)}
				data-testid="device-units"
			/>
			<ChoiceGroup
				legend="Distances on this device"
				variant="card"
				options={[
					{ value: 'km', label: 'Kilometres' },
					{ value: 'mi', label: 'Miles' }
				]}
				bind:value={() => preferences.distance, (d) => d && preferences.setDistance(d)}
				data-testid="device-distance"
			/>
		</div>
	</div>
</div>

<style>
	/* 36 px between the theme and each of this device's units. */
	.choices {
		display: grid;
		gap: var(--space-9);
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
	}
</style>
