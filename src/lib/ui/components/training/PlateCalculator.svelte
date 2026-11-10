<!--
  @component
  Plate calculator body: target weight stepper, bar choice and the loaded-sleeve picture.
  Opens in `initialUnit` (the app-wide preference, or a set's unit) at `initialTarget` (a set's
  weight) when given; switching units here is local to the calculator and never changes the
  preference. Loaded on demand (dynamic import) so the screens that open it hydrate without it.
  - Without `inventory` it uses M1's standard bars and plates, as it always has.
  - With this device's `inventory` (client/plates.ts, one per unit), the solver loads only what
    the gym has: a bar picked here is the device's, and 'Bar and plates' (the pencil beside the
    bar presets) opens the inventory editor (PlateInventory.svelte, its own chunk, fetched on
    that tap), whose every change `onInventoryChange` keeps.
-->
<script lang="ts">
	import type { PlateInventory as Inventory } from '#lib/client/plates.ts';
	import { calculatePlates, STANDARD_BARS, STANDARD_PLATES } from '#lib/domain/plates.ts';
	import {
		cleanFloat,
		convertWeight,
		DEFAULT_LOAD_INCREMENT,
		roundToIncrement,
		type WeightUnit
	} from '#lib/domain/units.ts';
	import Icon from '../Icon.svelte';
	import IconButton from '../IconButton.svelte';
	import NumberStepper from '../NumberStepper.svelte';
	import SegmentedControl from '../SegmentedControl.svelte';
	import PlateDiagram from './PlateDiagram.svelte';
	import type PlateInventoryView from './PlateInventory.svelte';
	import { barOptions } from './plate-choices.ts';

	interface Props {
		/** Unit the calculator opens in. */
		initialUnit: WeightUnit;
		/** Weight it opens at (a set's); the unit's usual target otherwise. */
		initialTarget?: number;
		/** This device's bar and plates, per unit; M1's standard ones when absent. */
		inventory?: Record<WeightUnit, Inventory>;
		/** Keeps a change to `unit`'s inventory; the parent passes the result back as `inventory`. */
		onInventoryChange?: (unit: WeightUnit, change: Partial<Inventory>) => void;
	}

	let { initialUnit, initialTarget, inventory, onInventoryChange }: Props = $props();

	const DEFAULTS: Record<WeightUnit, { target: number; bar: string }> = {
		kg: { target: 100, bar: '20' },
		lb: { target: 225, bar: '45' }
	};

	// The calculator's own state, seeded from what it opens with.
	// svelte-ignore state_referenced_locally
	let unit = $state(initialUnit);
	// svelte-ignore state_referenced_locally
	let target = $state(initialTarget ?? DEFAULTS[initialUnit].target);
	// svelte-ignore state_referenced_locally
	let barWeight = $state(DEFAULTS[initialUnit].bar);

	const stock = $derived(inventory?.[unit]);
	const bar = $derived(stock ? stock.bar : Number(barWeight));
	const bars = $derived(barOptions(unit, bar));
	const result = $derived(calculatePlates(target, bar, stock?.plates ?? STANDARD_PLATES[unit]));

	function pickBar(value: string) {
		if (stock) onInventoryChange?.(unit, { bar: Number(value) });
		else barWeight = value;
	}

	function changeUnit(next: WeightUnit) {
		if (next === unit) return;
		target = roundToIncrement(convertWeight(target, unit, next), DEFAULT_LOAD_INCREMENT[next]);
		const index = STANDARD_BARS[unit].findIndex((b) => String(b.weight) === barWeight);
		barWeight = String((STANDARD_BARS[next][Math.max(0, index)] ?? STANDARD_BARS[next][0]!).weight);
		unit = next;
	}

	// The inventory editor: its chunk is fetched on the first tap; a failed fetch says so, and the
	// next tap fetches again.
	let Editor = $state.raw<typeof PlateInventoryView | null>(null);
	let editing = $state(false);
	let failed = $state(false);
	const editorId = $props.id();

	function toggleEditor() {
		editing = !editing;
		failed = false;
		if (!editing || Editor) return;
		import('./PlateInventory.svelte')
			.then((module) => (Editor = module.default))
			.catch(() => (failed = true));
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
		min={bar}
		max={unit === 'kg' ? 500 : 1100}
		step={DEFAULT_LOAD_INCREMENT[unit]}
		bigStep={unit === 'kg' ? 10 : 25}
		data-testid="plates-target"
	/>

	<!-- 'Bar and plates' sits beside the bar presets, not under the result, so the calculator still
	     fits a 1024 × 700 window whole. -->
	<div class="bar">
		<SegmentedControl label="Bar" size="sm" value={String(bar)} options={bars} onchange={pickBar} />
		{#if stock && onInventoryChange}
			<IconButton
				icon="pencil"
				label="Bar and plates"
				size="sm"
				variant="filled"
				aria-expanded={editing}
				aria-controls={editorId}
				onclick={toggleEditor}
				data-testid="plates-inventory-toggle"
			/>
		{/if}
	</div>

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
		{#if result.remainder < 0}
			<p class="warning" data-testid="plates-warning">
				<Icon name="info" size={16} />
				<span>Below the {bar} {unit} bar — the lightest load is the empty bar.</span>
			</p>
		{:else if !result.exact}
			<p class="warning" data-testid="plates-warning">
				<Icon name="info" size={16} />
				<span
					>Closest loadable is {result.achieved}
					{unit} — {cleanFloat(result.remainder, 2)}
					{unit} short.</span
				>
			</p>
		{/if}
	</div>

	{#if stock && onInventoryChange}
		<div id={editorId} hidden={!editing}>
			{#if failed}
				<p class="warning" role="alert">
					<Icon name="alert" size={16} />
					<span>Couldn’t open bar and plates. Check your connection, then try again.</span>
				</p>
			{:else if Editor && editing}
				<Editor {unit} inventory={stock} onchange={(change) => onInventoryChange(unit, change)} />
			{/if}
		</div>
	{/if}
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

	.bar {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.bar > :global(:first-child) {
		flex: 1;
		min-width: 0;
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
