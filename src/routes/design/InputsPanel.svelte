<!-- /design: input primitives (loaded when its tab opens, keeping /design's initial JS small). -->
<script lang="ts">
	import type { Weekday } from '#lib/domain/profile/catalog.ts';
	import ChoiceGroup from '#lib/ui/components/ChoiceGroup.svelte';
	import DayPicker from '#lib/ui/components/DayPicker.svelte';
	import NumberField from '#lib/ui/components/NumberField.svelte';
	import NumberStepper from '#lib/ui/components/NumberStepper.svelte';
	import SegmentedControl from '#lib/ui/components/SegmentedControl.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import TagInput from '#lib/ui/components/TagInput.svelte';
	import TextArea from '#lib/ui/components/TextArea.svelte';
	import TextField from '#lib/ui/components/TextField.svelte';
	import Toggle from '#lib/ui/components/Toggle.svelte';

	let reps = $state(5);
	let rpe = $state(8);
	let range = $state<'4w' | '12w' | '1y'>('12w');
	let event = $state('Muay Thai fight');
	let oneRm = $state<number | null>(null);
	let bodyWeight = $state<number | null>(81.4);
	let notes = $state<string | null>(null);
	let level = $state<'novice' | 'intermediate' | 'advanced' | null>('intermediate');
	let gym = $state<'commercial' | 'home' | null>(null);
	let times = $state<('morning' | 'midday' | 'evening')[]>(['evening']);
	let unknown = $state(true);
	let days = $state<Weekday[]>(['tue', 'thu', 'sat']);
	let avoid = $state(['Overhead press']);
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

	<h3 class="h">Text & numbers</h3>
	<Surface padding="lg" radius="xl">
		<div class="grid">
			<TextField label="Event" bind:value={event} hint="Label above, never a placeholder" />
			<div class="pair">
				<NumberField label="Back squat 1RM" unit="kg" bind:value={oneRm} optional />
				<NumberField
					label="Body weight"
					unit="kg"
					bind:value={bodyWeight}
					error={bodyWeight !== null && bodyWeight < 25 ? 'Between 25 and 350 kg' : null}
				/>
			</div>
			<TextArea
				label="Notes"
				bind:value={notes}
				optional
				rows={2}
				placeholder="Night shifts every other week…"
			/>
		</div>
	</Surface>

	<h3 class="h">Choices</h3>
	<Surface padding="lg" radius="xl">
		<div class="grid">
			<ChoiceGroup
				legend="Level"
				bind:value={level}
				options={[
					{ value: 'novice', label: 'Novice' },
					{ value: 'intermediate', label: 'Intermediate' },
					{ value: 'advanced', label: 'Advanced' }
				]}
			/>
			<ChoiceGroup
				legend="Best time of day"
				hint="Pick any that work."
				multiple
				bind:values={times}
				options={[
					{ value: 'morning', label: 'Morning' },
					{ value: 'midday', label: 'Midday' },
					{ value: 'evening', label: 'Evening' }
				]}
			/>
			<ChoiceGroup
				legend="Where do you train most?"
				variant="card"
				bind:value={gym}
				options={[
					{ value: 'commercial', label: 'Commercial gym', hint: 'Racks, machines, cables' },
					{ value: 'home', label: 'Home or garage gym', hint: 'Your own rack and bar' }
				]}
			/>
			<DayPicker legend="Days you can train" bind:value={days} hint="Monday first." />
		</div>
	</Surface>

	<Surface padding="lg" radius="xl">
		<div class="grid">
			<Toggle
				label="I don’t know my 1RMs"
				description="Week one establishes them from RPE-based sets."
				bind:checked={unknown}
			/>
			<TagInput
				label="Movements to avoid"
				bind:value={avoid}
				suggestions={['Dips', 'Behind-the-neck press']}
				placeholder="e.g. Upright row"
			/>
		</div>
	</Surface>
</div>

<style>
	.grid {
		display: grid;
		gap: var(--space-4);
	}

	.pair {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-3);
		align-items: start;
	}

	.h {
		margin-top: var(--space-2);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--color-text-secondary);
	}
</style>
