<!--
  @component
  Train's plate-calculator sheet: the BottomSheet together with the calculator it holds. Train
  imports this on first intent, so neither weighs on the screen's initial JavaScript.
-->
<script lang="ts">
	import type { WeightUnit } from '#lib/domain/units.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import PlateCalculator from '#lib/ui/components/training/PlateCalculator.svelte';

	interface Props {
		open: boolean;
		/** Unit the calculator opens in (the app-wide preference). */
		unit: WeightUnit;
		onclose: () => void;
	}

	let { open = $bindable(), unit, onclose }: Props = $props();
</script>

<BottomSheet
	bind:open
	title="Plate calculator"
	description="Per side, heaviest plate first."
	{onclose}
	data-testid="plates-sheet"
>
	<PlateCalculator defaultUnit={unit} />
</BottomSheet>
