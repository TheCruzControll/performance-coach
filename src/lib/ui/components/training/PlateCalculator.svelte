<!--
  @component
  Plate calculator body: target weight stepper, bar choice and the loaded-sleeve picture.
  Presentational: the caller owns the unit preference. Loaded on demand (dynamic import) so
  the Train screen hydrates without it.
-->
<script lang="ts">
	import { calculatePlates, STANDARD_BARS, STANDARD_PLATES } from '#lib/domain/plates.ts';
	import {
		cleanFloat,
		convertWeight,
		DEFAULT_LOAD_INCREMENT,
		roundToIncrement,
		type WeightUnit
	} from '#lib/domain/units.ts';
	import Icon from '../Icon.svelte';
	import NumberStepper from '../NumberStepper.svelte';
	import SegmentedControl from '../SegmentedControl.svelte';
	import PlateDiagram from './PlateDiagram.svelte';

	interface Props {
		unit: WeightUnit;
		onunitchange: (unit: WeightUnit) => void;
	}

	let { unit, onunitchange }: Props = $props();

	const DEFAULTS: Record<WeightUnit, { target: number; bar: string }> = {
		kg: { target: 100, bar: '20' },
		lb: { target: 225, bar: '45' }
	};

	// Initial values follow the unit the calculator opens with.
	// svelte-ignore state_referenced_locally
	let target = $state(DEFAULTS[unit].target);
	// svelte-ignore state_referenced_locally
	let barWeight = $state(DEFAULTS[unit].bar);

	const bars = $derived(STANDARD_BARS[unit]);
	const result = $derived(calculatePlates(target, Number(barWeight), STANDARD_PLATES[unit]));

	function changeUnit(next: WeightUnit) {
		if (next === unit) return;
		target = roundToIncrement(convertWeight(target, unit, next), DEFAULT_LOAD_INCREMENT[next]);
		const index = STANDARD_BARS[unit].findIndex((b) => String(b.weight) === barWeight);
		barWeight = String((STANDARD_BARS[next][Math.max(0, index)] ?? STANDARD_BARS[next][0]!).weight);
		onunitchange(next);
	}
</script>

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

<style>
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
