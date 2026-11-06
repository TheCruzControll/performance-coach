<!-- /design: input primitives (loaded when its tab opens, keeping /design's initial JS small). -->
<script lang="ts">
	import NumberField from '#lib/ui/components/NumberField.svelte';
	import NumberStepper from '#lib/ui/components/NumberStepper.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import SegmentedControl from '#lib/ui/components/SegmentedControl.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import TextArea from '#lib/ui/components/TextArea.svelte';
	import TextField from '#lib/ui/components/TextField.svelte';

	let reps = $state(5);
	let rpe = $state(8);
	let range = $state<'4w' | '12w' | '1y'>('12w');

	// Each primitive blank and optional, filled, and with an error that clears once fixed.
	let oneRm = $state<number | null>(null);
	let bodyWeight = $state<number | null>(81.4);
	let rounds = $state<number | null>(5);
	let roundLength = $state<number | null>(3);
	let target = $state<number | null>(400);
	let raceDay = $state('');
	let fightNight = $state('2027-05-09');
	let eventDate = $state('');
	let notes = $state<string | null>(null);
	let limits = $state<string | null>(
		'Left shoulder: no overhead pressing until the physio clears it.'
	);
	let injury = $state<string | null>('');
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

	<Section title="Number field">
		<Surface padding="lg" radius="xl">
			<div class="fields">
				<NumberField
					label="Back squat 1RM"
					unit="kg"
					bind:value={oneRm}
					optional
					enterkeyhint="next"
					hint="Blank is fine: week one finds it."
				/>
				<div class="pair">
					<NumberField label="Body weight" unit="kg" bind:value={bodyWeight} />
					<NumberField
						label="Target weight"
						unit="kg"
						bind:value={target}
						hint="Where you want to be."
						error={target !== null && (target < 25 || target > 350)
							? 'Between 25 and 350 kg'
							: null}
					/>
				</div>
				<div class="pair">
					<NumberField label="Rounds" integer bind:value={rounds} hint="Whole rounds only." />
					<NumberField label="Round length" unit="min" bind:value={roundLength} />
				</div>
			</div>
		</Surface>
	</Section>

	<Section title="Date field">
		<Surface padding="lg" radius="xl">
			<div class="fields">
				<TextField label="Race day" type="date" bind:value={raceDay} optional />
				<TextField label="Fight night" type="date" bind:value={fightNight} />
				<TextField
					label="Event date"
					type="date"
					bind:value={eventDate}
					hint="The plan counts down to it."
					error={eventDate ? null : 'Pick the event date'}
				/>
			</div>
		</Surface>
	</Section>

	<Section title="Text area">
		<Surface padding="lg" radius="xl">
			<div class="fields">
				<TextArea
					label="Notes for the coach"
					bind:value={notes}
					optional
					maxlength={300}
					placeholder="Night shifts every other week…"
					hint="Up to 300 characters."
				/>
				<TextArea label="Limitations" bind:value={limits} rows={2} />
				<TextArea
					label="Injury"
					bind:value={injury}
					rows={2}
					hint="What hurts, and since when."
					error={injury?.trim() ? null : 'Say what hurts so the plan can work around it'}
				/>
			</div>
		</Surface>
	</Section>
</div>

<style>
	.grid {
		display: grid;
		gap: var(--space-3);
	}

	.fields {
		display: grid;
		gap: var(--space-5);
	}

	.pair {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-3);
		align-items: start;
	}
</style>
