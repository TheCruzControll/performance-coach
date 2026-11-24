<!--
  @component
  Profile → Body and nutrition (Paper, 9 · "Body and nutrition"): one field and three rows.
  Today's body weight (kept as a dated history) is the field; the nutrition phase opens a sheet
  to pick it, and the weight target and birth year each open a short sheet of fields. It informs
  training; it never overrides performance or recovery (PRD §3). Everything is optional.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { NUTRITION_PHASES, NUTRITION_PHASE_INFO } from '#lib/domain/profile/catalog.ts';
	import NumberField from '../components/NumberField.svelte';
	import PickRow from '../components/PickRow.svelte';
	import SheetRow from '../components/SheetRow.svelte';
	import TextField from '../components/TextField.svelte';
	import { targetValue, type BodyDraft } from './body';
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

	// The device's date, once mounted: until then the target's date says its year.
	let today = $state<Date | null>(null);
	onMount(() => (today = new Date()));
</script>

<div class="body">
	<NumberField
		label="Body weight"
		unit={value.weightUnit}
		bind:value={value.bodyWeight}
		error={errors.bodyWeight}
		optional
		hint={weightHint}
		enterkeyhint="done"
		data-testid="body-weight"
	/>
	<div class="rows">
		<PickRow
			label="Nutrition phase"
			description="It informs your training. It never overrides it."
			options={phases}
			bind:value={value.nutritionPhase}
			error={errors.nutritionPhase}
			data-testid="nutrition-phase"
		/>
		<SheetRow
			label="Target weight"
			value={targetValue(value, today)}
			error={errors.targetWeight ?? errors.targetDate}
			data-testid="target-weight-row"
		>
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
		</SheetRow>
		<SheetRow
			label="Birth year"
			value={value.birthYear != null ? String(value.birthYear) : undefined}
			error={errors.birthYear}
			data-testid="birth-year-row"
		>
			<NumberField
				label="Birth year"
				integer
				bind:value={value.birthYear}
				error={errors.birthYear}
				optional
				data-testid="birth-year"
			/>
		</SheetRow>
	</div>
</div>

<style>
	/* 20 px from the field to the rows (Paper). */
	.body {
		display: grid;
		gap: var(--space-5);
	}

	.rows {
		display: grid;
	}
</style>
