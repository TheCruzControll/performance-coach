<script lang="ts">
	import { onMount, type Component, type ComponentProps } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { preferences } from '#lib/client/preferences.svelte.ts';
	import Badge from '#lib/ui/components/Badge.svelte';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Chip from '#lib/ui/components/Chip.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import type PlateCalculatorType from '#lib/ui/components/training/PlateCalculator.svelte';

	type CalculatorProps = ComponentProps<typeof PlateCalculatorType>;

	const disciplines = [
		{ label: 'Strength', tone: 'strength' },
		{ label: 'Running', tone: 'running' },
		{ label: 'Muay Thai', tone: 'combat' },
		{ label: 'Hypertrophy', tone: 'hypertrophy' },
		{ label: 'Conditioning', tone: 'conditioning' }
	] as const;

	// The calculator is code-split: fetched on first intent (pointerdown/hover) or open, so the
	// Train screen ships and hydrates without it.
	let calculator = $state<Promise<{ default: Component<CalculatorProps> }> | null>(null);
	let sheetOpen = $state(false);

	function loadCalculator() {
		calculator ??= import('#lib/ui/components/training/PlateCalculator.svelte');
	}

	function openCalculator() {
		loadCalculator();
		sheetOpen = true;
	}

	onMount(() => {
		preferences.load();
		if (page.url.searchParams.get('tool') === 'plates') openCalculator();
	});

	function closeSheet() {
		if (page.url.searchParams.has('tool')) replaceState(resolve('/(app)/train'), {});
	}
</script>

<svelte:head>
	<title>Train · Performance Coach</title>
</svelte:head>

<PageHeader title="Train" eyebrow="Program" />

<div class="stack">
	<Surface padding="none" radius="xl">
		<EmptyState
			icon="train"
			title="No active program"
			description="Once your goals are in, your coach builds one plan across every discipline — and adapts it to each session you log."
			data-testid="train-empty"
		>
			{#snippet actions()}
				<p class="next" data-testid="train-next-step">
					Goal setup opens with passkey sign-in <Badge>Soon</Badge>
				</p>
			{/snippet}
		</EmptyState>
		<ul class="disciplines" aria-label="Supported disciplines">
			{#each disciplines as d (d.label)}
				<Chip as="li" tone={d.tone}>{d.label}</Chip>
			{/each}
		</ul>
	</Surface>

	<Section title="Tools">
		<ListRow
			icon="plate"
			tone="strength"
			title="Plate calculator"
			subtitle="Exact loading in kg or lb"
			onpointerdown={loadCalculator}
			onpointerenter={loadCalculator}
			onclick={openCalculator}
			data-testid="open-plates"
		/>
		<ListRow icon="timer" title="Rest timer" subtitle="Arrives with workout logging" disabled>
			{#snippet trailing()}<Badge>Soon</Badge>{/snippet}
		</ListRow>
	</Section>
</div>

<BottomSheet
	bind:open={sheetOpen}
	title="Plate calculator"
	description="Per side, heaviest plate first."
	onclose={closeSheet}
	data-testid="plates-sheet"
>
	{#if calculator}
		{#await calculator}
			<div class="loading" aria-busy="true">
				<Skeleton height="2.75rem" radius="var(--radius-full)" />
				<Skeleton height="5rem" radius="var(--radius-lg)" />
				<Skeleton height="10rem" radius="var(--radius-lg)" />
			</div>
		{:then { default: PlateCalculator }}
			<PlateCalculator defaultUnit={preferences.units} />
		{/await}
	{/if}
</BottomSheet>

<style>
	.stack {
		display: grid;
		gap: var(--space-6);
	}

	.next {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.disciplines {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: var(--space-2);
		margin: 0;
		padding: 0 var(--space-4) var(--space-6);
		list-style: none;
	}

	.loading {
		display: grid;
		gap: var(--space-5);
	}
</style>
