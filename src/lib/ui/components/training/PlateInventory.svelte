<!--
  @component
  This device's bar and plates for one unit, edited inside the plate calculator (its own chunk,
  fetched when the owner opens 'Bar and plates'): the bar's weight, for a bar none of the presets
  names (or 0 for a machine with no bar), and for each plate whether the gym has it and how many
  pairs (plate-choices.ts). Every change goes to `onchange` at once; the calculator's parent keeps
  it (client/plates.ts, per device and per unit) and the solver answers with it.
  Each plate is one radiogroup (one Tab stop; the arrows choose), with hover and focus rings.
-->
<script lang="ts">
	import { PLATE_LIMITS, type PlateInventory } from '#lib/client/plates.ts';
	import type { WeightUnit } from '#lib/domain/units.ts';
	import NumberStepper from '../NumberStepper.svelte';
	import SegmentedControl from '../SegmentedControl.svelte';
	import { plateRows, withChoice } from './plate-choices.ts';

	interface Props {
		unit: WeightUnit;
		inventory: PlateInventory;
		onchange: (change: Partial<PlateInventory>) => void;
	}

	let { unit, inventory, onchange }: Props = $props();

	const rows = $derived(plateRows(unit, inventory.plates));
	const id = $props.id();
</script>

<div class="editor" data-testid="plates-inventory">
	<NumberStepper
		value={inventory.bar}
		label="Bar weight"
		{unit}
		min={0}
		max={PLATE_LIMITS.bar[unit]}
		step={0.5}
		bigStep={5}
		hint="Pick a common bar above, or set your own here."
		onchange={(bar) => onchange({ bar })}
		data-testid="plates-bar"
	/>

	<section class="plates" aria-labelledby="{id}-plates">
		<h3 id="{id}-plates" class="heading">Plates</h3>
		<p class="hint">Pairs of each plate this gym has. Any means as many as a load needs.</p>
		<ul class="rows">
			{#each rows as row (row.weight)}
				<li class="row">
					<span class="weight numeric">{row.weight} {unit}</span>
					<SegmentedControl
						label="{row.weight} {unit} plates"
						size="sm"
						value={row.choice}
						options={row.options}
						onchange={(choice) =>
							onchange({ plates: withChoice(inventory.plates, row.weight, choice) })}
					/>
				</li>
			{/each}
		</ul>
	</section>
</div>

<style>
	.editor {
		display: grid;
		gap: var(--space-5);
	}

	.plates {
		display: grid;
		gap: var(--space-2);
	}

	.heading {
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
	}

	.hint {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.rows {
		display: grid;
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* The weight beside its choices: each option keeps ≥ 44 px of width at 393 px. */
	.row {
		display: grid;
		grid-template-columns: 4rem minmax(0, 1fr);
		align-items: center;
		gap: var(--space-3);
	}

	.weight {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}
</style>
