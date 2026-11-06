<!--
  @component
  Profile → Body & nutrition: today's body weight (kept as a dated history), birth year, the
  nutrition phase and a weight target. It informs training; it never overrides performance or
  recovery (PRD §3). Everything is optional.
-->
<script lang="ts">
	import { NUTRITION_PHASES, NUTRITION_PHASE_INFO } from '#lib/domain/profile/catalog.ts';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import NumberField from '../components/NumberField.svelte';
	import TextField from '../components/TextField.svelte';
	import type { BodyDraft } from './body';
	import type { EditorProps } from './editors';

	let { value = $bindable(), errors = {} }: EditorProps<BodyDraft> = $props();

	const phases = [
		...NUTRITION_PHASES.map((p) => ({
			value: p as BodyDraft['nutritionPhase'],
			...NUTRITION_PHASE_INFO[p]
		})),
		{ value: 'none' as const, label: 'Not focusing on it', hint: 'Eat to support training' }
	];

	// Until it is typed over, a weight recorded in the other unit says where its number came from.
	const weightHint = $derived(
		value.recorded && value.bodyWeight === value.recorded.shown
			? `Converted from ${value.recorded.value} ${value.recorded.unit}`
			: 'Today’s, roughly'
	);
</script>

<div class="body">
	<div class="pair">
		<NumberField
			label="Body weight"
			unit={value.weightUnit}
			bind:value={value.bodyWeight}
			error={errors.bodyWeight}
			optional
			hint={weightHint}
			enterkeyhint="next"
			data-testid="body-weight"
		/>
		<NumberField
			label="Birth year"
			integer
			bind:value={value.birthYear}
			error={errors.birthYear}
			optional
			data-testid="birth-year"
		/>
	</div>
	<ChoiceGroup
		legend="Nutrition phase"
		hint="It informs your training; it never overrides it."
		variant="card"
		bind:value={value.nutritionPhase}
		error={errors.nutritionPhase}
		options={phases}
		data-testid="nutrition-phase"
	/>
	<div class="pair">
		<NumberField
			label="Target weight"
			unit={value.weightUnit}
			bind:value={value.targetWeight}
			error={errors.targetWeight}
			optional
			enterkeyhint="next"
			data-testid="target-weight"
		/>
		<TextField
			label="By when"
			type="date"
			bind:value={() => value.targetDate ?? '', (date) => (value.targetDate = date || null)}
			error={errors.targetDate}
			optional
			data-testid="target-date"
		/>
	</div>
</div>

<style>
	.body {
		display: grid;
		gap: var(--space-6);
	}

	/* Two short fields side by side: a weight and a year fit half a phone's width each. */
	.pair {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-3);
		align-items: start;
	}
</style>
