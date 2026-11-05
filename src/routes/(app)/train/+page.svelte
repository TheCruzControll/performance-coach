<script lang="ts">
	import { onMount, type Component, type ComponentProps } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { preferences } from '#lib/client/preferences.svelte.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import type PlateCalculatorType from '#lib/ui/components/training/PlateCalculator.svelte';

	type CalculatorProps = ComponentProps<typeof PlateCalculatorType>;

	const disciplines = [
		{ label: 'Strength', color: 'var(--color-strength)' },
		{ label: 'Running', color: 'var(--color-running)' },
		{ label: 'Muay Thai', color: 'var(--color-combat)' },
		{ label: 'Hypertrophy', color: 'var(--color-hypertrophy)' },
		{ label: 'Conditioning', color: 'var(--color-conditioning)' }
	];

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
				<Button
					href={resolve('/(app)/profile')}
					variant="secondary"
					size="sm"
					iconEnd="arrow-right"
				>
					Set goals
				</Button>
			{/snippet}
		</EmptyState>
		<ul class="disciplines" aria-label="Supported disciplines">
			{#each disciplines as d (d.label)}
				<li class="chip"><span class="dot" style:background={d.color}></span>{d.label}</li>
			{/each}
		</ul>
	</Surface>

	<section aria-labelledby="tools-heading" class="tools">
		<h2 id="tools-heading" class="section-title">Tools</h2>
		<button
			type="button"
			class="tool"
			onpointerdown={loadCalculator}
			onpointerenter={loadCalculator}
			onclick={openCalculator}
			data-testid="open-plates"
		>
			<span class="tool-icon" style:--tone="var(--color-strength)"
				><Icon name="plate" size={22} /></span
			>
			<span class="tool-text">
				<span class="tool-title">Plate calculator</span>
				<span class="tool-sub">Exact loading in kg or lb</span>
			</span>
			<Icon name="chevron-right" size={20} />
		</button>
		<div class="tool" aria-disabled="true">
			<span class="tool-icon" style:--tone="var(--color-running)"
				><Icon name="timer" size={22} /></span
			>
			<span class="tool-text">
				<span class="tool-title">Rest timer</span>
				<span class="tool-sub">Arrives with workout logging</span>
			</span>
			<span class="soon">Soon</span>
		</div>
	</section>
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
			<PlateCalculator unit={preferences.units} onunitchange={(u) => preferences.setUnits(u)} />
		{/await}
	{/if}
</BottomSheet>

<style>
	.stack {
		display: grid;
		gap: var(--space-6);
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

	.chip {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1-5);
		padding: var(--space-1) var(--space-3);
		border-radius: var(--radius-full);
		border: 1px solid var(--color-border);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
	}

	.section-title {
		margin-bottom: var(--space-3);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-normal);
		color: var(--color-text-secondary);
	}

	.tools {
		display: grid;
		gap: var(--space-2);
	}

	.tools .section-title {
		margin-bottom: var(--space-1);
	}

	.tool {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		width: 100%;
		min-height: 4.25rem;
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
		box-shadow: var(--elevation-1);
		color: var(--color-text-tertiary);
		text-align: left;
		transition: transform var(--duration-fast) var(--ease-out);
	}

	button.tool:active {
		transform: scale(0.985);
		transition-duration: var(--duration-instant);
	}

	.tool[aria-disabled='true'] {
		opacity: 0.6;
	}

	.tool-icon {
		display: grid;
		place-items: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--tone) 14%, transparent);
		color: var(--tone);
	}

	.tool-text {
		flex: 1;
		display: grid;
	}

	.tool-title {
		font-weight: var(--weight-semibold);
		color: var(--color-text);
	}

	.tool-sub {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.soon {
		font-size: var(--text-2xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius-full);
		background: var(--color-surface-2);
	}

	.loading {
		display: grid;
		gap: var(--space-5);
	}
</style>
