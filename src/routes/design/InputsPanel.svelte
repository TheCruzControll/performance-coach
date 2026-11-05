<!-- /design: input primitives (loaded when its tab opens, keeping /design's initial JS small). -->
<script lang="ts">
	import NumberStepper from '#lib/ui/components/NumberStepper.svelte';
	import SegmentedControl from '#lib/ui/components/SegmentedControl.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';

	let reps = $state(5);
	let rpe = $state(8);
	let range = $state<'4w' | '12w' | '1y'>('12w');
</script>

<div class="grid">
	<Surface padding="lg" radius="xl">
		<div class="grid">
			<NumberStepper bind:value={reps} label="Reps" min={0} max={50} />
			<NumberStepper
				bind:value={rpe}
				label="RPE"
				min={6}
				max={10}
				step={0.5}
				hint="Reps in reserve: {10 - rpe}"
			/>
		</div>
	</Surface>
	<SegmentedControl
		label="Range"
		bind:value={range}
		options={[
			{ value: '4w', label: '4 weeks' },
			{ value: '12w', label: '12 weeks' },
			{ value: '1y', label: '1 year' }
		]}
	/>
</div>

<style>
	.grid {
		display: grid;
		gap: var(--space-3);
	}
</style>
