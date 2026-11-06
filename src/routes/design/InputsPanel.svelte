<!-- /design: input primitives (loaded when its tab opens, keeping /design's initial JS small). -->
<script lang="ts">
	import type { Weekday } from '#lib/domain/profile/catalog.ts';
	import ChoiceGroup from '#lib/ui/components/ChoiceGroup.svelte';
	import DayPicker from '#lib/ui/components/DayPicker.svelte';
	import NumberField from '#lib/ui/components/NumberField.svelte';
	import NumberStepper from '#lib/ui/components/NumberStepper.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import SegmentedControl from '#lib/ui/components/SegmentedControl.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import TagInput from '#lib/ui/components/TagInput.svelte';
	import TextArea from '#lib/ui/components/TextArea.svelte';
	import TextField from '#lib/ui/components/TextField.svelte';
	import Toggle from '#lib/ui/components/Toggle.svelte';

	let reps = $state(5);
	let rpe = $state(8);
	// A stepper with an error until it fits the three free days.
	let trainingDays = $state(5);
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

	// Choices: one, an optional one ("Any" stands for null), several, one card, several cards
	// with an error until one is picked, and days. Values are shown so order and null can be seen.
	let level = $state<'novice' | 'intermediate' | 'advanced' | null>('intermediate');
	let timeOfDay = $state<'morning' | 'evening' | null>(null);
	let disciplines = $state<string[]>(['strength']);
	let gym = $state<'commercial' | 'home' | 'none' | null>('commercial');
	let equipment = $state<string[]>([]);
	let days = $state<Weekday[]>(['tue', 'thu', 'sat']);
	let strengthDays = $state<Weekday[]>(['wed']);

	// A switch with and without a description; a list with suggestions, a limit of three and
	// 60 characters an item; two lists whose error clears once they no longer overlap.
	let unknownMaxes = $state(true);
	let home = $state(false);
	let avoid = $state(['Overhead press']);
	let likes = $state(['Front squat']);
	let dislikes = $state(['Burpees', 'front squat']);
	const overlap = $derived(
		dislikes.some((d) => likes.some((l) => l.toLowerCase() === d.toLowerCase()))
	);
</script>

{#snippet readout(testId: string, value: unknown)}
	<p class="readout" data-testid={testId}>value: {JSON.stringify(value)}</p>
{/snippet}

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
			<NumberStepper
				bind:value={trainingDays}
				label="Training days"
				min={1}
				max={7}
				hint="Tue, Thu and Sat are free."
				error={trainingDays > 3 ? `Only 3 days are free: ${trainingDays} won’t fit` : null}
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

	<Section title="Choice group">
		<Surface padding="lg" radius="xl">
			<div class="fields">
				<ChoiceGroup
					legend="Level"
					bind:value={level}
					options={[
						{ value: 'novice', label: 'Novice' },
						{ value: 'intermediate', label: 'Intermediate' },
						{ value: 'advanced', label: 'Advanced' }
					]}
				/>
				<div class="with-value">
					<ChoiceGroup
						legend="Best time to train"
						hint="Any leaves it to the coach."
						bind:value={() => timeOfDay ?? 'any', (v) => (timeOfDay = v && v !== 'any' ? v : null)}
						options={[
							{ value: 'any', label: 'Any' },
							{ value: 'morning', label: 'Morning' },
							{ value: 'evening', label: 'Evening' }
						]}
					/>
					{@render readout('time-value', timeOfDay)}
				</div>
				<div class="with-value">
					<ChoiceGroup
						legend="Disciplines"
						hint="Pick any that apply."
						multiple
						bind:values={disciplines}
						options={[
							{ value: 'strength', label: 'Strength', tone: 'strength' },
							{ value: 'running', label: 'Running', tone: 'running' },
							{ value: 'muay_thai', label: 'Muay Thai', tone: 'combat' },
							{ value: 'hypertrophy', label: 'Hypertrophy', tone: 'hypertrophy' }
						]}
					/>
					{@render readout('disciplines-value', disciplines)}
				</div>
				<ChoiceGroup
					legend="Where do you train most?"
					variant="card"
					bind:value={gym}
					options={[
						{ value: 'commercial', label: 'Commercial gym', hint: 'Racks, machines, cables' },
						{ value: 'home', label: 'Home or garage gym', hint: 'Your own rack and bar' },
						{ value: 'none', label: 'No gym', hint: 'Bodyweight, bands and the road' }
					]}
				/>
				<ChoiceGroup
					legend="Equipment at home"
					variant="card"
					multiple
					bind:values={equipment}
					error={equipment.length ? null : 'Pick at least one so the plan uses only what you have'}
					options={[
						{ value: 'barbell', label: 'Barbell and rack', hint: 'Squat, bench and deadlift' },
						{ value: 'dumbbells', label: 'Dumbbells', hint: 'A set or an adjustable pair' }
					]}
				/>
			</div>
		</Surface>
	</Section>

	<Section title="Day picker">
		<Surface padding="lg" radius="xl">
			<div class="fields">
				<div class="with-value">
					<DayPicker
						legend="Days you can train"
						bind:value={days}
						hint="Tap every day that works."
					/>
					{@render readout('days-value', days)}
				</div>
				<DayPicker
					legend="Strength days"
					bind:value={strengthDays}
					hint="Two or more."
					error={strengthDays.length >= 2 ? null : 'Pick at least two days for strength'}
				/>
			</div>
		</Surface>
	</Section>

	<Section title="Toggle">
		<Surface padding="lg" radius="xl">
			<div class="fields">
				<div class="with-value">
					<Toggle
						label="I don’t know my 1RMs"
						description="Week one finds them from how hard the sets feel."
						bind:checked={unknownMaxes}
					/>
					{@render readout('toggle-value', unknownMaxes)}
				</div>
				<Toggle label="I also train at home" bind:checked={home} />
			</div>
		</Surface>
	</Section>

	<Section title="Tag input">
		<Surface padding="lg" radius="xl">
			<div class="fields">
				<div class="with-value">
					<TagInput
						label="Movements to avoid"
						bind:value={avoid}
						max={3}
						maxlength={60}
						placeholder="e.g. Upright row"
						hint="Up to three here, 60 characters each."
						suggestions={['Dips', 'Behind-the-neck press', 'Upright row']}
						data-testid="tags-avoid"
					/>
					{@render readout('tags-value', avoid)}
				</div>
				<TagInput
					label="Exercises you enjoy"
					bind:value={likes}
					placeholder="e.g. Front squat"
					hint="The coach leans on these when there’s a choice."
					data-testid="tags-likes"
				/>
				<TagInput
					label="Exercises you’d rather skip"
					bind:value={dislikes}
					placeholder="e.g. Burpees"
					hint="Swapped for an equivalent."
					error={overlap ? 'Each exercise once: it can’t be liked and skipped' : null}
					data-testid="tags-skip"
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

	.with-value {
		display: grid;
		gap: var(--space-2);
	}

	.readout {
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
		overflow-wrap: anywhere;
	}
</style>
