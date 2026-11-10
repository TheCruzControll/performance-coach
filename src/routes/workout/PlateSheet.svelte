<!--
  @component
  The workout's plate calculator, opened from a set row of an exercise loaded with a bar or
  plates: M1's calculator at that set's weight and unit, with this device's bar and plates
  (client/plates.ts, the inventory Train's calculator uses too), whose every change is kept.
  Code-split with its BottomSheet (a centred dialog from 1024 px) and fetched on the row
  button's first touch, so none of it weighs on /workout's initial JavaScript. Each tap opens it
  afresh from that set; closing returns focus to the row's button.
-->
<script lang="ts">
	import { readPlateInventory, writePlateInventory } from '#lib/client/plates.ts';
	import type { WeightUnit } from '#lib/domain/units.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import PlateCalculator from '#lib/ui/components/training/PlateCalculator.svelte';

	interface Props {
		/** The tapped set, a new object per tap: its weight (when it has one), unit and name. */
		request: { target?: number; unit: WeightUnit; label: string };
	}

	let { request }: Props = $props();

	let open = $state(false);
	$effect.pre(() => {
		void request;
		open = true;
	});

	let inventory = $state({ kg: readPlateInventory('kg'), lb: readPlateInventory('lb') });
</script>

<BottomSheet
	bind:open
	title="Plate calculator"
	description={request.label}
	data-testid="workout-plates"
>
	{#key request}
		<PlateCalculator
			initialUnit={request.unit}
			initialTarget={request.target}
			{inventory}
			onInventoryChange={(unit, change) =>
				(inventory[unit] = writePlateInventory(unit, change).inventory)}
		/>
	{/key}
</BottomSheet>
