<!--
  @component
  Body and nutrition: body weight (kept as history), the nutrition phase and a weight target.
  It informs training; it never overrides performance or recovery (PRD §3). All optional.
-->
<script lang="ts">
	import { NUTRITION_PHASES, NUTRITION_PHASE_INFO } from '#lib/domain/profile/catalog.ts';
	import type { FieldErrors } from '#lib/domain/profile/schemas.ts';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import NumberField from '../components/NumberField.svelte';
	import TextField from '../components/TextField.svelte';
	import type { BodyDraft } from './forms';

	interface Props {
		value: BodyDraft;
		errors?: FieldErrors;
	}

	let { value = $bindable(), errors = {} }: Props = $props();

	const phases = [
		...NUTRITION_PHASES.map((p) => ({
			value: p as (typeof NUTRITION_PHASES)[number] | 'none',
			label: NUTRITION_PHASE_INFO[p].label,
			hint: NUTRITION_PHASE_INFO[p].hint
		})),
		{ value: 'none' as const, label: 'Not focusing on it', hint: 'Eat to support training' }
	];
</script>

<div class="body">
	<div class="pair">
		<NumberField
			label="Body weight"
			unit={value.weightUnit}
			bind:value={value.bodyWeight}
			error={errors.bodyWeight}
			optional
			hint="Today’s, roughly"
			data-testid="body-weight"
		/>
		<NumberField
			label="Birth year"
			integer
			bind:value={value.birthYear}
			error={errors.birthYear}
			optional
			placeholder="1994"
			data-testid="birth-year"
		/>
	</div>
	<ChoiceGroup
		legend="Nutrition phase"
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
			data-testid="target-weight"
		/>
		<TextField
			label="By when"
			type="date"
			value={value.targetDate ?? ''}
			oninput={(e) => (value.targetDate = e.currentTarget.value || null)}
			error={errors.targetDate}
			hint="Optional"
		/>
	</div>
</div>

<style>
	.body {
		display: grid;
		gap: var(--space-6);
	}

	.pair {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-3);
		align-items: start;
	}
</style>
