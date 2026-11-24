<!--
  @component
  Bar and plates (Instrument v2, Paper 4 · Train "Your bar and plates"): this device's bar and
  plates for one unit, as a sheet over the plate calculator's (its own chunk, fetched when the
  owner opens it). The bar's weight is a row that opens a sheet with its stepper, for a bar none
  of the presets names (or 0 for a machine with no bar); each plate, heaviest first, is a row with
  its answer (None, its pairs or Any) that opens a pick-one sheet (PickRow; plate-choices.ts).
  Every change goes to `onchange` at once; the calculator's parent keeps it (client/plates.ts, per
  device and per unit) and the solver answers with it. The body scrolls when the rows outgrow it.
-->
<script lang="ts">
	import { PLATE_LIMITS, type PlateInventory } from '#lib/client/plates.ts';
	import type { WeightUnit } from '#lib/domain/units.ts';
	import BottomSheet from '../BottomSheet.svelte';
	import NumberStepper from '../NumberStepper.svelte';
	import PickRow from '../PickRow.svelte';
	import SheetRow from '../SheetRow.svelte';
	import { barValue, inventoryLead, plateRows, withChoice } from './plate-choices.ts';

	interface Props {
		open: boolean;
		unit: WeightUnit;
		inventory: PlateInventory;
		onchange: (change: Partial<PlateInventory>) => void;
	}

	let { open = $bindable(), unit, inventory, onchange }: Props = $props();

	const rows = $derived(plateRows(unit, inventory.plates));
</script>

<BottomSheet
	bind:open
	title="Bar and plates"
	description={inventoryLead(unit)}
	data-testid="plates-inventory"
>
	<!-- The rows straight in the sheet's body: a hairline under each but the last. -->
	<SheetRow
		label="Bar weight"
		value={barValue(inventory.bar, unit)}
		data-testid="plates-bar-weight"
	>
		<NumberStepper
			value={inventory.bar}
			label="Bar weight"
			size="md"
			hideLabel
			{unit}
			min={0}
			max={PLATE_LIMITS.bar[unit]}
			step={0.5}
			bigStep={5}
			hint="For a bar none of the presets names. 0 is a machine with no bar."
			onchange={(bar) => onchange({ bar })}
			data-testid="plates-bar"
		/>
	</SheetRow>
	{#each rows as row (row.weight)}
		<PickRow
			label="{row.weight} {unit}"
			description="How many pairs of {row.weight} {unit} plates this gym has."
			options={row.options}
			bind:value={
				() => row.choice,
				(choice) =>
					choice !== null && onchange({ plates: withChoice(inventory.plates, row.weight, choice) })
			}
			data-testid="plate-{row.weight}"
		/>
	{/each}
</BottomSheet>
