<script lang="ts">
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { preferences } from '#lib/client/preferences.svelte.ts';
	import { calculatePlates, STANDARD_BARS, STANDARD_PLATES } from '#lib/domain/plates.ts';
	import {
		cleanFloat,
		convertWeight,
		DEFAULT_LOAD_INCREMENT,
		roundToIncrement,
		type WeightUnit
	} from '#lib/domain/units.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import NumberStepper from '#lib/ui/components/NumberStepper.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import SegmentedControl from '#lib/ui/components/SegmentedControl.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import PlateDiagram from '#lib/ui/components/training/PlateDiagram.svelte';

	const disciplines = [
		{ label: 'Strength', color: 'var(--color-strength)' },
		{ label: 'Running', color: 'var(--color-running)' },
		{ label: 'Muay Thai', color: 'var(--color-combat)' },
		{ label: 'Hypertrophy', color: 'var(--color-hypertrophy)' },
		{ label: 'Conditioning', color: 'var(--color-conditioning)' }
	];

	// ---- Plate calculator ---------------------------------------------------------------
	let sheetOpen = $state(false);
	let target = $state(100);
	let barWeight = $state('20');

	const unit = $derived(preferences.units);
	const bars = $derived(STANDARD_BARS[unit]);
	const result = $derived(calculatePlates(target, Number(barWeight), STANDARD_PLATES[unit]));

	function changeUnit(next: WeightUnit) {
		if (next === unit) return;
		target = roundToIncrement(convertWeight(target, unit, next), DEFAULT_LOAD_INCREMENT[next]);
		const index = STANDARD_BARS[unit].findIndex((b) => String(b.weight) === barWeight);
		barWeight = String(
			STANDARD_BARS[next][Math.max(0, index)]?.weight ?? STANDARD_BARS[next][0]!.weight
		);
		preferences.setUnits(next);
	}

	onMount(() => {
		preferences.load();
		if (preferences.units === 'lb') {
			target = 225;
			barWeight = '45';
		}
		if (page.url.searchParams.get('tool') === 'plates') sheetOpen = true;
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
		<button type="button" class="tool" onclick={() => (sheetOpen = true)} data-testid="open-plates">
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
	<div class="calc">
		<SegmentedControl
			label="Units"
			value={unit}
			options={[
				{ value: 'kg', label: 'Kilograms' },
				{ value: 'lb', label: 'Pounds' }
			]}
			onchange={changeUnit}
		/>

		<NumberStepper
			bind:value={target}
			label="Target weight"
			{unit}
			min={0}
			max={unit === 'kg' ? 500 : 1100}
			step={DEFAULT_LOAD_INCREMENT[unit]}
			bigStep={unit === 'kg' ? 10 : 25}
			data-testid="plates-target"
		/>

		<SegmentedControl
			label="Bar"
			size="sm"
			bind:value={barWeight}
			options={bars.map((b) => ({ value: String(b.weight), label: `${b.weight} ${unit} bar` }))}
		/>

		<div class="result" aria-live="polite">
			<PlateDiagram plates={result.perSide} {unit} />
			{#if result.perSide.length}
				<p class="per-side numeric" data-testid="plates-result">
					{result.perSide.join(' · ')}
					<span class="per-side-unit">{unit} per side</span>
				</p>
			{:else}
				<p class="per-side muted">Just the bar</p>
			{/if}
			{#if !result.exact && result.remainder > 0}
				<p class="warning">
					<Icon name="info" size={16} />
					Closest loadable is {result.achieved}
					{unit} — {cleanFloat(result.remainder, 2)}
					{unit} short.
				</p>
			{/if}
		</div>
	</div>
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

	.calc {
		display: grid;
		gap: var(--space-5);
	}

	.result {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-3) var(--space-4);
		border-radius: var(--radius-lg);
		background: var(--color-surface-2);
		border: 1px solid var(--color-border);
	}

	.per-side {
		text-align: center;
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
	}

	.per-side-unit {
		display: block;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
		color: var(--color-text-tertiary);
		letter-spacing: var(--tracking-normal);
	}

	.muted {
		color: var(--color-text-tertiary);
	}

	.warning {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-1-5);
		font-size: var(--text-sm);
		color: var(--color-warning);
	}
</style>
