<!--
  @component
  The plate calculator's body (Instrument v2, Paper 4 · Train "Plates for a bar" and 5 · Workout
  "Plates per side"): a 52 px stepper for the target, the plates for one side as one line with
  what it means ('25 · 15 · 1.25', 'kg on each side, heaviest first'), a note when the load can't
  be made (the closest one, and how short), then Bar, Units and Bar and plates as rows. The answer
  follows each step: there is no Calculate. Bar and Units are pick-one rows (PickRow), each opening
  a sheet over the calculator's.
  Opens in `initialUnit` (the app-wide preference, or a set's unit) at `initialTarget` (a set's
  weight) when given; switching units here is local to the calculator and never changes the
  preference. Loaded on demand (dynamic import) so the screens that open it hydrate without it.
  - Without `inventory` it uses M1's standard bars and plates, as it always has.
  - With this device's `inventory` (client/plates.ts, one per unit), the solver loads only what
    the gym has: a bar picked here is the device's, and the Bar and plates row opens its sheet
    (PlateInventory.svelte, its own chunk, fetched on that tap), whose every change
    `onInventoryChange` keeps.
-->
<script lang="ts">
	import type { PlateInventory as Inventory } from '#lib/client/plates.ts';
	import { calculatePlates, STANDARD_BARS, STANDARD_PLATES } from '#lib/domain/plates.ts';
	import {
		convertWeight,
		DEFAULT_LOAD_INCREMENT,
		roundToIncrement,
		type WeightUnit
	} from '#lib/domain/units.ts';
	import ListRow from '../ListRow.svelte';
	import NumberStepper from '../NumberStepper.svelte';
	import PickRow from '../PickRow.svelte';
	import type PlateInventoryView from './PlateInventory.svelte';
	import {
		barOptions,
		barValue,
		inventoryValue,
		plateAnswer,
		UNIT_WORDS
	} from './plate-choices.ts';

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

	const UNIT_OPTIONS = (['kg', 'lb'] as const).map((value) => ({
		value,
		label: UNIT_WORDS[value]
	}));

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
	const answer = $derived(plateAnswer(result, target, bar, unit));

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

	// Bar and plates: its chunk is fetched on the first tap, and its sheet opens once it arrives; a
	// failed fetch says so under the rows, and the next tap fetches again.
	let Editor = $state.raw<typeof PlateInventoryView | null>(null);
	let editing = $state(false);
	let failed = $state(false);

	function openEditor() {
		editing = true;
		failed = false;
		if (Editor) return;
		import('./PlateInventory.svelte')
			.then((module) => (Editor = module.default))
			.catch(() => {
				failed = true;
				editing = false;
			});
	}
</script>

<div class="calc">
	<NumberStepper
		bind:value={target}
		label="Target weight"
		size="md"
		hideLabel
		{unit}
		min={bar}
		max={unit === 'kg' ? 500 : 1100}
		step={DEFAULT_LOAD_INCREMENT[unit]}
		bigStep={unit === 'kg' ? 10 : 25}
		data-testid="plates-target"
	/>

	<!-- The answer and its note, announced together as they change. -->
	<div aria-live="polite">
		<div class="answer">
			<p class="line" data-testid="plates-result">{answer.line}</p>
			{#if answer.caption}<p class="caption" data-testid="plates-caption">{answer.caption}</p>{/if}
		</div>
		{#if answer.note}<p class="note" data-testid="plates-warning">{answer.note}</p>{/if}
	</div>

	<div class="rows">
		<PickRow
			label="Bar"
			options={bars}
			bind:value={() => String(bar), (value) => value !== null && pickBar(value)}
			summary={barValue(bar, unit)}
			data-testid="plates-bar-row"
		/>
		<PickRow
			label="Units"
			options={UNIT_OPTIONS}
			bind:value={() => unit, (value) => value !== null && changeUnit(value)}
			data-testid="plates-units-row"
		/>
		{#if stock && onInventoryChange}
			<ListRow
				title="Bar and plates"
				value={inventoryValue(unit, stock)}
				aria-haspopup="dialog"
				onclick={openEditor}
				data-testid="plates-inventory-toggle"
			/>
		{/if}
	</div>
	{#if failed}
		<p class="failed" role="alert">
			Couldn’t open bar and plates. Check your connection, then try again.
		</p>
	{/if}
</div>

{#if Editor && stock && onInventoryChange}
	<Editor
		bind:open={editing}
		{unit}
		inventory={stock}
		onchange={(change) => onInventoryChange(unit, change)}
	/>
{/if}

<style>
	.calc {
		display: grid;
	}

	/* Paper: the plates centred, 32/38 Mona in 600, the caption 4 px under it. 16 px under it when
	   a note follows, 24 otherwise. */
	.answer {
		display: grid;
		justify-items: center;
		gap: var(--space-1);
		padding: var(--space-6) 0;
		text-align: center;
	}

	.answer:has(+ .note) {
		padding-bottom: var(--space-4);
	}

	.line {
		font: var(--type-statement);
		font-family: var(--font-numeric);
		letter-spacing: var(--tracking-statement);
		font-variant-numeric: lining-nums;
	}

	.caption {
		font: var(--type-secondary);
		color: var(--color-text-tertiary);
	}

	/* The load the gym can't make: the closest one, and how short. Plain words, no warning colour. */
	.note {
		padding-bottom: var(--space-6);
		font: var(--type-body);
		color: var(--color-text);
		text-align: center;
	}

	.rows {
		display: grid;
		border-top: 1px solid var(--color-hairline);
	}

	/* v2: an error is one red line. */
	.failed {
		padding: var(--space-2) 0;
		font: var(--type-secondary);
		color: var(--color-danger);
	}
</style>
