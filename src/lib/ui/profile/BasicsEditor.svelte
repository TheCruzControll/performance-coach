<!--
  @component
  Profile → Name and units, also onboarding's welcome step (Paper, 9 · "Name and units"): what the
  coach calls the athlete, then the units it plans and talks in. Units are two choice lists.
  Saving also switches this device to those units (./basics.ts); per-device units stay on
  Appearance.
-->
<script lang="ts">
	import type { BasicsInput } from '#lib/domain/profile/schemas.ts';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import TextField from '../components/TextField.svelte';
	import type { EditorProps } from './editors';

	let { value = $bindable(), errors = {} }: EditorProps<BasicsInput> = $props();
</script>

<div class="basics">
	<TextField
		label="What should your coach call you?"
		hint="A first name or a nickname."
		bind:value={value.name}
		error={errors.name}
		autocomplete="given-name"
		autocapitalize="words"
		enterkeyhint="done"
		maxlength={64}
		data-testid="basics-name"
	/>
	<div class="units">
		<ChoiceGroup
			legend="Weights in"
			variant="card"
			bind:value={value.weightUnit}
			options={[
				{ value: 'kg', label: 'Kilograms' },
				{ value: 'lb', label: 'Pounds' }
			]}
			data-testid="basics-weights"
		/>
		<ChoiceGroup
			legend="Distances in"
			variant="card"
			bind:value={value.distanceUnit}
			options={[
				{ value: 'km', label: 'Kilometres' },
				{ value: 'mi', label: 'Miles' }
			]}
			data-testid="basics-distances"
		/>
		<p class="note">Your coach plans in these units. Saving also switches this device to them.</p>
	</div>
</div>

<style>
	/* 28 px from the name to "Weights in", 20 between the two lists (Paper). */
	.basics {
		display: grid;
		gap: var(--space-7);
	}

	.units {
		display: grid;
		gap: var(--space-5);
	}

	.note {
		font: var(--type-caption);
		color: var(--color-text-tertiary);
	}
</style>
